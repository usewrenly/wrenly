/**
 * COMPONENT: Explicit failed-rehearsal recovery
 * PURPOSE: Settle a disposable rehearsal without executing migrations against real data.
 * INPUTS: Current owner, exact interrupted operation/revision, request identity and instance directory.
 * OUTPUTS: Durable cleanup/inspection receipts and a failed original action; never a successful migration.
 * STEPS: Fence exact rehearsal effects, clean only their disposable scope, inspect original schema/journal,
 * explicitly start the preserved runtime if stopped, then recheck evidence and acknowledge recovery with a fresh resource revision.
 * EDGE CASES: Lost acknowledgements replay; unrelated effects and changed history stay blocked.
 * ERROR STATES: Unknown cleanup or original schema changes preserve recovery-required state.
 */
import {
  inspectProductionResourceState,
  type ProductionRecoveryTarget,
} from "./production-targets/data/recovery";
import { logger } from "../../lib/logger";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  appDatabases,
  appDatabaseOperations,
  appDatabaseMigrations,
  appDatabaseBackups,
  projects,
  type db,
} from "@wrenly/db";
import {
  DatabaseRecovery,
  type DatabaseActionAcknowledgement,
} from "@wrenly/db/app-database-action-contract";
import { cleanupDatabaseValidationResources } from "@wrenly/sandbox/database-validation-cleanup";
import {
  inspectManagedDatabaseSchema,
  cleanupManagedDatabaseInspector,
} from "@wrenly/sandbox/database-administrator";
import {
  inspectManagedDatabaseState,
  setManagedDatabaseRunning,
} from "@wrenly/sandbox";
import {
  isFailedDisposableRehearsal,
  isInterruptedRehearsalRecovery,
} from "./rehearsal-recovery-policy";
import { getDatabaseWorkerBundle } from "./database-worker-bundle";

import {
  readProjectCapabilities,
  requireProjectCapability,
} from "../projects/access/project-access";
import { AppDatabaseError } from "./database-contract";
import { acquireDatabaseExecutorLock } from "./database-executor-lock";
import {
  DATABASE_LEASE_MS,
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  heldClaim,
  loadDatabaseExecution,
  renewDatabaseAction,
  assertDatabaseCleanupLease,
  acknowledgeDatabaseCleanupEffect,
  interruptDatabaseAction,
  type DatabaseClaim,
} from "./database-store";
const MAX_RECOVERY_ATTEMPTS = 16;
const RECOVERY_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 5000;
type Operation = typeof appDatabaseOperations.$inferSelect;
const pointsTo = (operation: Operation, id: string): boolean =>
  operation.kind === "recover-rehearsal" &&
  operation.effect?.kind === "inspect-rehearsal-operation" &&
  operation.effect.id === id;

/** Rehearsal cleanup cannot run application code or accept a replacement migration. */
export async function recoverDatabaseRehearsal(
  database: typeof db,
  projectId: string,
  actorId: string,
  value: unknown,
  directory: string,
  cleanupResources: typeof cleanupDatabaseValidationResources = cleanupDatabaseValidationResources,
  inspectSchema: typeof inspectManagedDatabaseSchema = inspectManagedDatabaseSchema,
  runtime = {
    inspect: inspectManagedDatabaseState,
    start: setManagedDatabaseRunning,
    cleanupInspector: cleanupManagedDatabaseInspector,
  },
  production?: ProductionRecoveryTarget,
  inspectProduction: typeof inspectProductionResourceState = inspectProductionResourceState,
): Promise<DatabaseActionAcknowledgement> {
  const parsed = DatabaseRecovery.safeParse(value);
  if (!parsed.success)
    throw new AppDatabaseError(
      400,
      "Review the exact failed rehearsal and current database revision.",
    );
  const input = parsed.data;
  const access = await readProjectCapabilities(database, projectId, actorId);
  if (access?.role !== "owner")
    throw new AppDatabaseError(
      access ? 403 : 404,
      access
        ? "Only the project owner can recover database validation."
        : "Project not found.",
    );
  const identity = createHash("sha256")
    .update(JSON.stringify([projectId, "recover-rehearsal", input]))
    .digest("hex");
  const replay = async (
    connection: Pick<typeof database, "select"> = database,
  ): Promise<DatabaseActionAcknowledgement | null> => {
    const [row] = await connection
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          eq(appDatabaseOperations.actorId, actorId),
          eq(appDatabaseOperations.requestId, input.requestId),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (
      row.kind !== "recover-rehearsal" ||
      row.projectId !== projectId ||
      row.requestIdentity !== identity
    )
      throw new AppDatabaseError(
        409,
        "This request identity belongs to another database action.",
      );
    return { operationId: row.id, resourceId: row.databaseId, replayed: true };
  };
  const saved = await replay();
  if (saved) return saved;
  if (!access.manage)
    throw new AppDatabaseError(
      403,
      "Restore the project before starting rehearsal recovery.",
    );
  const [selected] = await database
    .select()
    .from(appDatabaseOperations)
    .where(
      and(
        eq(appDatabaseOperations.id, input.operationId),
        eq(appDatabaseOperations.projectId, projectId),
      ),
    )
    .limit(1);
  const migrationId =
    selected?.kind === "recover-rehearsal" &&
    selected.effect?.kind === "inspect-rehearsal-operation"
      ? selected.effect.id
      : input.operationId;
  const [original] = await database
    .select({
      operation: appDatabaseOperations,
      review: appDatabaseMigrations,
      backup: appDatabaseBackups,
    })
    .from(appDatabaseOperations)
    .innerJoin(
      appDatabaseMigrations,
      eq(appDatabaseMigrations.operationId, appDatabaseOperations.id),
    )
    .innerJoin(
      appDatabaseBackups,
      eq(appDatabaseBackups.id, appDatabaseMigrations.backupId),
    )
    .where(
      and(
        eq(appDatabaseOperations.id, migrationId),
        eq(appDatabaseOperations.projectId, projectId),
        eq(appDatabaseOperations.kind, "migrate"),
      ),
    )
    .limit(1);
  if (
    !original ||
    !original.backup.verifiedAt ||
    original.backup.databaseId !== original.operation.databaseId ||
    original.backup.schemaDigest !== original.review.beforeSchemaDigest
  )
    throw new AppDatabaseError(
      409,
      "A verified matching rehearsal backup is required.",
    );
  const claim: DatabaseClaim = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    projectId,
    resourceId: original.operation.databaseId,
  };
  const lock = await acquireDatabaseExecutorLock(claim).catch(() => {
    throw new AppDatabaseError(
      409,
      "The prior rehearsal executor is still cleaning up. Wait before reviewing recovery.",
    );
  });
  let admitted = false,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    renewal: Promise<void> | undefined;
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let stage = "admission";
  let accessRevision = "";
  let priorRecoveries: Operation[] = [];
  let originalResource!: typeof appDatabases.$inferSelect;
  const assertHeld = async (): Promise<void> => {
    lock.assertHeld();
    if (Date.now() >= deadline)
      throw new AppDatabaseError(409, "Validation recovery deadline elapsed.");
    await assertDatabaseCleanupLease(database, claim);
    const current = await readProjectCapabilities(database, projectId, actorId);
    const [project] = await database
      .select({ revision: projects.accessRevision })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!current?.manage || project?.revision !== accessRevision)
      throw new AppDatabaseError(
        409,
        "Project access changed during rehearsal recovery.",
      );
    lock.assertHeld();
  };
  try {
    const receipt = await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      const again = await replay(tx);
      if (again) return again;
      await requireDatabaseProjectIdle(tx, projectId);
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.id, claim.resourceId),
            eq(appDatabases.projectId, projectId),
          ),
        )
        .for("update");
      const [target] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(eq(appDatabaseOperations.id, migrationId))
        .for("update");
      const pending = await tx
        .select()
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.projectId, projectId),
            inArray(appDatabaseOperations.status, [
              "queued",
              "running",
              "interrupted",
            ]),
          ),
        )
        .limit(MAX_RECOVERY_ATTEMPTS + 1);
      if (
        !resource ||
        (resource.environment === "production" && !production) ||
        resource.status !== "recovery_required" ||
        resource.revision !== input.expectedRevision ||
        !target ||
        !isFailedDisposableRehearsal(resource, target, original.review) ||
        target.kind !== "migrate" ||
        target.status !== "interrupted" ||
        target.databaseId !== claim.resourceId ||
        pending.length > MAX_RECOVERY_ATTEMPTS ||
        pending.some(
          (row) =>
            row.id !== target.id &&
            !isInterruptedRehearsalRecovery(resource, row, target.id),
        )
      )
        throw new AppDatabaseError(
          409,
          "Database recovery changed or unrelated work remains. Reload before reviewing cleanup.",
        );
      originalResource = resource;
      priorRecoveries = pending.filter((row) => row.id !== target.id);
      const [project] = await tx
        .select({ revision: projects.accessRevision })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) throw new Error("Project missing");
      accessRevision = project.revision;
      await tx.insert(appDatabaseOperations).values({
        id: claim.id,
        databaseId: claim.resourceId,
        projectId,
        actorId,
        requestId: input.requestId,
        requestIdentity: identity,
        kind: "recover-rehearsal",
        status: "running",
        expectedRevision: input.expectedRevision,
        claimToken: claim.token,
        leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS),
        effect: {
          kind: "inspect-rehearsal-operation",
          id: target.id,
          startedAt: new Date().toISOString(),
        },
      });
      return null;
    });
    if (receipt) return receipt;
    admitted = true;
    heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = (async (): Promise<void> => {
        try {
          await assertHeld();
          await renewDatabaseAction(database, claim);
        } catch {
          /* The next cleanup fence refuses mutation. */
        }
      })().finally(() => {
        renewal = undefined;
      });
    }, HEARTBEAT_MS);
    const recordRecoveryEffect = async (
      kind: string,
      id: string,
    ): Promise<void> => {
      await assertHeld();
      const rows = await database
        .update(appDatabaseOperations)
        .set({
          cleanupEffect: {
            kind,
            id,
            startedAt: new Date().toISOString(),
          },
        })
        .where(
          and(heldClaim(claim), isNull(appDatabaseOperations.cleanupEffect)),
        )
        .returning({ id: appDatabaseOperations.id });
      if (rows.length !== 1)
        throw new AppDatabaseError(409, "Recovery intent could not be saved.");
    };
    const scope = {
      resourceId: claim.resourceId,
      projectId,
      // Rehearsal helpers live only in the local Development namespace, even for a Production rehearsal.
      environment: "development" as const,
    };
    stage = "prior inspector cleanup";
    for (const prior of priorRecoveries) {
      const id = `wrenly-database-administrator-${prior.id}`;
      await recordRecoveryEffect("cleanup-prior-inspector", id);
      await runtime.cleanupInspector(scope, prior.id, assertHeld);
      await acknowledgeDatabaseCleanupEffect(database, claim, id);
    }
    const cleanup = {
      assertHeld,
      beforeCleanup: async (
        kind: "application" | "socket" | "database",
        id: string,
      ): Promise<void> => {
        await assertHeld();
        const expected =
          kind === "database"
            ? `wrenly-database-${migrationId}`
            : `wrenly-database-${kind}-${migrationId}`;
        if (id !== expected)
          throw new AppDatabaseError(409, "Recovery cleanup scope changed.");
        const changed = await database
          .update(appDatabaseOperations)
          .set({
            cleanupEffect: {
              kind: `cleanup-validation-${kind}`,
              id,
              startedAt: new Date().toISOString(),
            },
          })
          .where(
            and(
              heldClaim(claim),
              eq(appDatabaseOperations.kind, "recover-rehearsal"),
              isNull(appDatabaseOperations.cleanupEffect),
            ),
          )
          .returning({ id: appDatabaseOperations.id });
        if (changed.length !== 1)
          throw new AppDatabaseError(
            409,
            "Recovery cleanup intent could not be saved.",
          );
      },
      acknowledgeCleanup: async (
        _kind: "application" | "socket" | "database",
        id: string,
      ): Promise<void> => {
        await assertHeld();
        await acknowledgeDatabaseCleanupEffect(database, claim, id);
      },
    };
    stage = "disposable rehearsal cleanup";
    await cleanupResources(
      { projectId, resourceId: migrationId, environment: "development" },
      migrationId,
      claim.resourceId,
      cleanup,
    );
    // The trusted inspector hashes schema and native migration journals; no app code or migration runs.
    await assertHeld();
    const inspectorId = `wrenly-database-administrator-${claim.id}`;
    const saveInspection = async (): Promise<void> => {
      await assertHeld();
      const rows = await database
        .update(appDatabaseOperations)
        .set({
          cleanupEffect: {
            kind: "verify-rehearsal-source",
            id: inspectorId,
            startedAt: new Date().toISOString(),
          },
        })
        .where(
          and(heldClaim(claim), isNull(appDatabaseOperations.cleanupEffect)),
        )
        .returning({ id: appDatabaseOperations.id });
      if (rows.length !== 1)
        throw new AppDatabaseError(409, "Inspection intent unavailable.");
    };
    stage = "original schema inspection";
    let schema: string;
    if (originalResource.environment === "production") {
      await saveInspection();
      const state = await inspectProduction(
        database,
        projectId,
        actorId,
        claim.resourceId,
        input.expectedRevision,
        production!,
      );
      await assertHeld();
      if (state !== "ready" || !originalResource.schemaDigest)
        throw new AppDatabaseError(
          409,
          "The original Production database is not ready for read-only inspection.",
        );
      // The Production inspector independently compares actual schema and native journals to this saved digest.
      schema = originalResource.schemaDigest;
      await acknowledgeDatabaseCleanupEffect(database, claim, inspectorId);
    } else {
      const execution = await loadDatabaseExecution(database, claim, directory);
      if (!execution.resource.runtimeIdentity)
        throw new AppDatabaseError(409, "Database identity missing.");
      stage = "preserved runtime readiness";
      const runtimeIdentity = execution.resource.runtimeIdentity;
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      if ((await runtime.inspect(scope, runtimeIdentity)) === "stopped") {
        await runtime.start(
          scope,
          runtimeIdentity,
          true,
          {
            assertHeld,
            beforeEffect: async (effect) => {
              if (
                effect.kind !== "start" ||
                effect.id !== runtimeIdentity.containerId
              )
                throw new AppDatabaseError(
                  409,
                  "Preserved runtime start identity changed.",
                );
              await recordRecoveryEffect("start-preserved-database", effect.id);
            },
            acknowledgeEffect: async (effect) => {
              if (
                effect.kind !== "start" ||
                effect.id !== runtimeIdentity.containerId
              )
                throw new AppDatabaseError(
                  409,
                  "Preserved runtime start receipt changed.",
                );
              await assertHeld();
              await acknowledgeDatabaseCleanupEffect(
                database,
                claim,
                effect.id,
              );
            },
          },
          signal,
        );
      }
      if ((await runtime.inspect(scope, runtimeIdentity)) !== "ready")
        throw new AppDatabaseError(
          409,
          "The preserved database is not ready for inspection.",
        );
      schema = await inspectSchema({
        scope: {
          resourceId: claim.resourceId,
          projectId,
          environment: "development",
        },
        database: execution.resource.runtimeIdentity,
        operationId: claim.id,
        credentials: execution.credentials,
        administratorBundle: await getDatabaseWorkerBundle("administrator"),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        fence: {
          assertHeld,
          beforeEffect: async (effect) => {
            if (effect.kind !== "inspect-schema" || effect.id !== inspectorId)
              throw new AppDatabaseError(
                409,
                "Unexpected source inspection effect.",
              );
            await saveInspection();
          },
          acknowledgeEffect: async () => {
            await assertHeld();
            await acknowledgeDatabaseCleanupEffect(
              database,
              claim,
              inspectorId,
            );
          },
        },
      });
    }
    stage = "schema comparison";
    if (schema !== original.review.beforeSchemaDigest)
      throw new AppDatabaseError(
        409,
        "The original schema or migration journal changed. Preserve recovery.",
      );
    await assertHeld();
    await database.transaction(async (tx) => {
      // Completion is a worker receipt, not a new HTTP admission.
      await lockDatabaseQueues(tx, { wait: true });
      await requireProjectCapability(tx, projectId, actorId, "manage");
      await requireDatabaseProjectIdle(tx, projectId);
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(eq(appDatabases.id, claim.resourceId))
        .for("update");
      if (
        resource &&
        (resource.environment !== originalResource.environment ||
          resource.provider !== originalResource.provider ||
          JSON.stringify(resource.providerIdentity) !==
            JSON.stringify(originalResource.providerIdentity))
      )
        throw new AppDatabaseError(
          409,
          "Original database binding changed during recovery.",
        );
      const [recovery] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .for("update");
      const pending = await tx
        .select()
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.projectId, projectId),
            inArray(appDatabaseOperations.status, [
              "queued",
              "running",
              "interrupted",
            ]),
          ),
        )
        .limit(MAX_RECOVERY_ATTEMPTS + 1);
      if (
        !resource ||
        resource.projectId !== projectId ||
        resource.status !== "recovery_required" ||
        resource.revision !== input.expectedRevision ||
        !recovery ||
        !pointsTo(recovery, migrationId) ||
        recovery.cleanupEffect ||
        pending.length > MAX_RECOVERY_ATTEMPTS ||
        !pending.some(
          (row) =>
            row.id === migrationId &&
            row.status === "interrupted" &&
            row.kind === "migrate",
        ) ||
        pending.some(
          (row) =>
            row.id !== migrationId &&
            row.id !== claim.id &&
            !isInterruptedRehearsalRecovery(resource, row, migrationId),
        ) ||
        pending
          .filter((row) => row.id !== claim.id && row.id !== migrationId)
          .some(
            (row) =>
              !priorRecoveries.some(
                (prior) => JSON.stringify(prior) === JSON.stringify(row),
              ),
          ) ||
        priorRecoveries.some(
          (prior) =>
            !recovery.completedCleanupEffects.some(
              (effect) =>
                effect.kind === "cleanup-prior-inspector" &&
                effect.id === `wrenly-database-administrator-${prior.id}`,
            ),
        ) ||
        !(["application", "socket", "database"] as const).every((kind) =>
          recovery.completedCleanupEffects.some(
            (effect) =>
              effect.kind === `cleanup-validation-${kind}` &&
              effect.id ===
                (kind === "database"
                  ? `wrenly-database-${migrationId}`
                  : `wrenly-database-${kind}-${migrationId}`),
          ),
        )
      )
        throw new AppDatabaseError(
          409,
          "Recovery confirmation changed. Preserve its blocker.",
        );
      const [currentReview] = await tx
        .select()
        .from(appDatabaseMigrations)
        .where(eq(appDatabaseMigrations.operationId, migrationId));
      const target = pending.find((row) => row.id === migrationId);
      const [currentBackup] = await tx
        .select()
        .from(appDatabaseBackups)
        .where(eq(appDatabaseBackups.id, original.backup.id));
      if (
        !currentBackup ||
        JSON.stringify(currentBackup) !== JSON.stringify(original.backup) ||
        !currentReview ||
        !target ||
        !isFailedDisposableRehearsal(resource, target, currentReview) ||
        JSON.stringify(currentReview) !== JSON.stringify(original.review) ||
        !recovery.completedCleanupEffects.some(
          (effect) =>
            effect.kind === "verify-rehearsal-source" &&
            effect.id === inspectorId,
        )
      )
        throw new AppDatabaseError(
          409,
          "Rehearsal evidence changed during recovery.",
        );
      await assertHeld();
      await tx
        .update(appDatabases)
        .set({
          status: "ready",
          revision: crypto.randomUUID(),
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(appDatabases.id, resource.id),
            eq(appDatabases.revision, input.expectedRevision),
          ),
        );
      for (const old of pending.filter((row) => row.id !== claim.id))
        await tx
          .update(appDatabaseOperations)
          .set({
            status: "failed",
            errorCode: "RECOVERED_REHEARSAL",
            claimToken: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          })
          .where(eq(appDatabaseOperations.id, old.id));
      const closed = await tx
        .update(appDatabaseOperations)
        .set({
          status: "success",
          effect: null,
          completedEffects: [...recovery.completedEffects, recovery.effect!],
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (closed.length !== 1) throw new Error("Recovery lease lost");
    });
    return {
      operationId: claim.id,
      resourceId: claim.resourceId,
      replayed: false,
    };
  } catch (error) {
    logger.error("Rehearsal recovery stopped", {
      operationId: claim.id,
      projectId,
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    if (admitted) await interruptDatabaseAction(database, claim);
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "Validation cleanup could not be confirmed. Check the saved request before reviewing another action.",
    );
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (renewal) await renewal;
    await lock.release();
  }
}
