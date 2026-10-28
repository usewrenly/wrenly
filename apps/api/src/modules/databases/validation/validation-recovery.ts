/**
 * COMPONENT: Owner-reviewed interrupted validation cleanup
 * PURPOSE: Remove only the old disposable resources without repeating app/SQL execution.
 * INPUTS: Current owner, interrupted validation ID, real resource revision and action UUID.
 * OUTPUTS: Audited cleanup receipt; old uncertain primary effects remain in history.
 * STEPS: Check replay/authority, hold the source resource lock, record recovery and
 * independent cleanup intents, verify disposable absence, close matching blockers.
 * EDGE CASES: Lost replies replay receipts only; a new reviewed attempt may supersede
 * interrupted cleanup of the same target, but never unrelated work or foreign resources.
 * ERROR STATES: Unknown cleanup remains interrupted; real database identity/state is unchanged.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  appDatabases,
  appDatabaseOperations,
  appDatabaseValidations,
  projects,
  type db,
} from "@wrenly/db";
import {
  DatabaseRecovery,
  type DatabaseActionAcknowledgement,
} from "@wrenly/db/app-database-action-contract";
import { cleanupDatabaseValidationResources } from "@wrenly/sandbox/database-validation-cleanup";
import { cleanupOwnedRuntimeArtifact } from "@wrenly/sandbox/runtime-artifact-cleanup";
import type { ValidationCleanupKind } from "./validation-effects";
import {
  readProjectCapabilities,
  requireProjectCapability,
} from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";
import { acquireDatabaseExecutorLock } from "../database-executor-lock";
import {
  DATABASE_LEASE_MS,
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  heldClaim,
  renewDatabaseAction,
  assertDatabaseCleanupLease,
  acknowledgeDatabaseCleanupEffect,
  interruptDatabaseAction,
  type DatabaseClaim,
} from "../database-store";
const MAX_RECOVERY_ATTEMPTS = 16;
const RECOVERY_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 5000;
type Operation = typeof appDatabaseOperations.$inferSelect;
const pointsTo = (operation: Operation, id: string): boolean =>
  operation.kind === "recover-validation" &&
  operation.effect?.kind === "inspect-validation-operation" &&
  operation.effect.id === id;

/** No generated source is loaded here; the prepared image remains the build owner's separate artifact. */
export async function recoverDatabaseValidation(
  database: typeof db,
  projectId: string,
  actorId: string,
  value: unknown,
  cleanupResources: typeof cleanupDatabaseValidationResources = cleanupDatabaseValidationResources,
  cleanupArtifact: typeof cleanupOwnedRuntimeArtifact = cleanupOwnedRuntimeArtifact,
): Promise<DatabaseActionAcknowledgement> {
  const parsed = DatabaseRecovery.safeParse(value);
  if (!parsed.success)
    throw new AppDatabaseError(
      400,
      "Review the exact interrupted validation and current database revision.",
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
    .update(JSON.stringify([projectId, "recover-validation", input]))
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
      row.kind !== "recover-validation" ||
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
      "Restore the project before starting validation recovery.",
    );
  const [original] = await database
    .select({
      operation: appDatabaseOperations,
      ownsArtifact: appDatabaseValidations.ownsArtifact,
    })
    .from(appDatabaseOperations)
    .innerJoin(
      appDatabaseValidations,
      eq(appDatabaseValidations.operationId, appDatabaseOperations.id),
    )
    .where(
      and(
        eq(appDatabaseOperations.id, input.operationId),
        eq(appDatabaseOperations.projectId, projectId),
        eq(appDatabaseOperations.kind, "validate-application"),
      ),
    )
    .limit(1);
  if (!original) throw new AppDatabaseError(404, "Saved validation not found.");
  const claim: DatabaseClaim = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    projectId,
    resourceId: original.operation.databaseId,
  };
  const lock = await acquireDatabaseExecutorLock(claim).catch(() => {
    throw new AppDatabaseError(
      409,
      "The prior validation executor is still cleaning up. Wait before reviewing recovery.",
    );
  });
  let admitted = false,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    renewal: Promise<void> | undefined;
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let accessRevision = "";
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
        "Project access changed during validation recovery.",
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
        .where(eq(appDatabaseOperations.id, input.operationId))
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
        resource.environment !== "development" ||
        resource.provider !== "local" ||
        resource.status !== "ready" ||
        resource.revision !== input.expectedRevision ||
        !target ||
        target.kind !== "validate-application" ||
        target.status !== "interrupted" ||
        target.databaseId !== claim.resourceId ||
        pending.length > MAX_RECOVERY_ATTEMPTS ||
        pending.some(
          (row) =>
            row.id !== target.id &&
            !(pointsTo(row, target.id) && row.status === "interrupted"),
        )
      )
        throw new AppDatabaseError(
          409,
          "Database recovery changed or unrelated work remains. Reload before reviewing cleanup.",
        );
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
        kind: "recover-validation",
        status: "running",
        expectedRevision: input.expectedRevision,
        claimToken: claim.token,
        leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS),
        effect: {
          kind: "inspect-validation-operation",
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
    const cleanup = {
      assertHeld,
      beforeCleanup: async (
        kind: ValidationCleanupKind,
        id: string,
      ): Promise<void> => {
        await assertHeld();
        const expected =
          kind === "artifact"
            ? `wrenly-artifact-${input.operationId}`
            : kind === "database"
              ? `wrenly-database-${input.operationId}`
              : `wrenly-database-${kind}-${input.operationId}`;
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
              eq(appDatabaseOperations.kind, "recover-validation"),
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
        _kind: ValidationCleanupKind,
        id: string,
      ): Promise<void> => {
        await assertHeld();
        await acknowledgeDatabaseCleanupEffect(database, claim, id);
      },
    };
    await cleanupResources(
      { projectId, resourceId: input.operationId, environment: "development" },
      input.operationId,
      claim.resourceId,
      cleanup,
    );
    if (original.ownsArtifact) {
      const id = `wrenly-artifact-${input.operationId}`;
      await cleanup.beforeCleanup("artifact", id);
      await cleanupArtifact(input.operationId, assertHeld);
      await cleanup.acknowledgeCleanup("artifact", id);
    }
    await assertHeld();
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      await requireDatabaseProjectIdle(tx, projectId);
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(eq(appDatabases.id, claim.resourceId))
        .for("update");
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
        resource.status !== "ready" ||
        resource.revision !== input.expectedRevision ||
        !recovery ||
        !pointsTo(recovery, input.operationId) ||
        recovery.cleanupEffect ||
        (original.ownsArtifact &&
          !recovery.completedCleanupEffects.some(
            (effect) =>
              effect.kind === "cleanup-validation-artifact" &&
              effect.id === `wrenly-artifact-${input.operationId}`,
          )) ||
        pending.length > MAX_RECOVERY_ATTEMPTS ||
        !pending.some(
          (row) =>
            row.id === input.operationId &&
            row.status === "interrupted" &&
            row.kind === "validate-application",
        ) ||
        pending.some(
          (row) =>
            row.id !== input.operationId &&
            row.id !== claim.id &&
            !(pointsTo(row, input.operationId) && row.status === "interrupted"),
        ) ||
        !(["application", "socket", "database"] as const).every((kind) =>
          recovery.completedCleanupEffects.some(
            (effect) =>
              effect.kind === `cleanup-validation-${kind}` &&
              effect.id ===
                (kind === "database"
                  ? `wrenly-database-${input.operationId}`
                  : `wrenly-database-${kind}-${input.operationId}`),
          ),
        )
      )
        throw new AppDatabaseError(
          409,
          "Recovery confirmation changed. Preserve its blocker.",
        );
      await assertHeld();
      for (const old of pending.filter((row) => row.id !== claim.id))
        await tx
          .update(appDatabaseOperations)
          .set({
            status: "failed",
            errorCode: "RECOVERED_VALIDATION_CLEANUP",
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
