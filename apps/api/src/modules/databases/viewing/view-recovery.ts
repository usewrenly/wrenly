import { isRecoverableDatabaseRead } from "./view-recovery-policy";
import {
  inspectProductionResourceState,
  type ProductionRecoveryTarget,
} from "../production-targets/data/recovery";
/**
 * COMPONENT: Owner-reviewed abandoned read recovery
 * PURPOSE: Close one interrupted read's owned helpers without replaying its query.
 * INPUTS: Current owner, original read ID, resource revision and action UUID.
 * OUTPUTS: Audited cleanup confirmation; old rows and uncertain read outcomes stay lost.
 * STEPS: Check replay/owner, hold resource lock, save a recovery claim pointing to
 * the interrupted read, record cleanup intent, remove exact owned helpers, inspect
 * the saved database identity, recheck owner/revision and release the recovery fence.
 * EDGE CASES: Old unresolved recovery attempts retain history; a new explicit action
 * may supersede expired attempts only after verified cleanup of the same read.
 * ERROR STATES: Foreign resources, mutation effects, stale authority or cleanup failure
 * leave the database blocked. No generated app code or SQL executes in recovery.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { appDatabases, appDatabaseOperations, type db } from "@wrenly/db";
import { inspectManagedDatabaseState } from "@wrenly/sandbox";
import { cleanupAbandonedDatabaseRead } from "@wrenly/sandbox/database-read-cleanup";
import {
  requireProjectCapability,
  readProjectCapabilities,
} from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";
import { DatabaseRecovery } from "@wrenly/db/app-database-action-contract";
import { acquireDatabaseExecutorLock } from "../database-executor-lock";
import {
  DATABASE_LEASE_MS,
  lockDatabaseQueues,
  heldClaim,
  renewDatabaseAction,
  recordDatabaseCleanupEffect,
  acknowledgeDatabaseCleanupEffect,
  assertDatabaseCleanupLease,
  interruptDatabaseAction,
  type DatabaseClaim,
} from "../database-store";

const RECOVERY_DEADLINE_MS = 60_000;
const HEARTBEAT_MS = 5000;
const MAX_RECOVERY_ATTEMPTS = 16;
type Operation = typeof appDatabaseOperations.$inferSelect;
export type RecoveryResult = {
  operationId: string;
  resourceId: string;
  replayed: boolean;
};

export interface DatabaseCleanupRecoveryStrategy {
  kind: "recover-read" | "recover-production-operation";
  intent: "inspect-read-operation" | "inspect-production-operation";
  validate: (operation: Operation) => void;
  cleanup: (input: {
    database: typeof db;
    claim: DatabaseClaim;
    original: Operation;
    assertHeld: () => Promise<void>;
  }) => Promise<void>;
  inspect: (input: {
    resource: typeof appDatabases.$inferSelect;
    original: Operation;
    assertHeld: () => Promise<void>;
  }) => Promise<void>;
  finish?: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    original: Operation,
  ) => Promise<void>;
}

function requireReadEffects(operation: Operation): void {
  if (!isRecoverableDatabaseRead(operation))
    throw new AppDatabaseError(
      409,
      "This operation is not a bounded reader cleanup. Preserve its recovery fence.",
    );
}

/** Explicit cleanup only; it never reopens a socket, returns rows or acknowledges old SQL. */
export async function executeDatabaseCleanupRecovery(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
  production?: ProductionRecoveryTarget,
  strategy?: DatabaseCleanupRecoveryStrategy,
): Promise<RecoveryResult> {
  const recoveryKind = strategy?.kind ?? "recover-read";
  const intentKind = strategy?.intent ?? "inspect-read-operation";
  const validate = strategy?.validate ?? requireReadEffects;
  const pointsToRead = (operation: Operation, target: string): boolean =>
    operation.kind === recoveryKind &&
    operation.effect?.kind === intentKind &&
    operation.effect.id === target;
  const parsed = DatabaseRecovery.safeParse(body);
  if (!parsed.success)
    throw new AppDatabaseError(
      400,
      "Review the interrupted read and current database revision.",
    );
  const input = parsed.data;
  const access = await readProjectCapabilities(database, projectId, actorId);
  if (access?.role !== "owner")
    throw new AppDatabaseError(
      access ? 403 : 404,
      access
        ? "Only the project owner can recover database reads."
        : "Project not found.",
    );
  const identity = createHash("sha256")
    .update(JSON.stringify([projectId, recoveryKind, input]))
    .digest("hex");
  const replay = async (
    connection: Pick<typeof database, "select"> = database,
  ): Promise<RecoveryResult | null> => {
    const [row] = await connection
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          eq(appDatabaseOperations.actorId, actorId),
          eq(appDatabaseOperations.requestId, input.requestId),
        ),
      );
    if (!row) return null;
    if (
      row.kind !== recoveryKind ||
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
      "Restore the project before starting database recovery.",
    );
  const [original] = await database
    .select()
    .from(appDatabaseOperations)
    .where(
      and(
        eq(appDatabaseOperations.id, input.operationId),
        eq(appDatabaseOperations.projectId, projectId),
      ),
    );
  if (!original)
    throw new AppDatabaseError(404, "Database operation not found.");
  validate(original);
  const claim: DatabaseClaim = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    resourceId: original.databaseId,
    projectId,
  };
  const lock = await acquireDatabaseExecutorLock(claim).catch(() => {
    throw new AppDatabaseError(
      409,
      "The previous executor is still cleaning up. Wait before reviewing recovery again.",
    );
  });
  let admitted = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | undefined;
  let lost = false;
  const deadline = Date.now() + RECOVERY_DEADLINE_MS;
  try {
    const admittedResource = await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      const found = await replay(tx);
      if (found) return { replay: found };
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
        .where(eq(appDatabaseOperations.id, original.id))
        .for("update");
      if (
        !resource ||
        resource.revision !== input.expectedRevision ||
        resource.status !== "recovery_required" ||
        !(
          (resource.provider === "local" &&
            resource.environment === "development" &&
            resource.runtimeIdentity) ||
          (resource.provider === "postgres-cluster" &&
            resource.environment === "production" &&
            production)
        ) ||
        target?.status !== "interrupted"
      )
        throw new AppDatabaseError(
          409,
          "Review the current interrupted database operation before recovery.",
        );
      validate(target);
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
        pending.length >= MAX_RECOVERY_ATTEMPTS ||
        pending.some(
          (row) =>
            row.id !== original.id &&
            (!pointsToRead(row, original.id) ||
              (row.status === "running" &&
                row.leaseExpiresAt &&
                row.leaseExpiresAt.getTime() > Date.now())),
        )
      )
        throw new AppDatabaseError(
          409,
          "Another database operation still needs attention before recovery.",
        );
      lock.assertHeld();
      for (const prior of pending.filter(
        (row) => row.id !== original.id && row.status === "running",
      )) {
        await tx
          .update(appDatabaseOperations)
          .set({
            status: "interrupted",
            claimToken: null,
            leaseExpiresAt: null,
            errorCode: "SUPERSEDED_READ_RECOVERY",
          })
          .where(eq(appDatabaseOperations.id, prior.id));
      }
      await tx.insert(appDatabaseOperations).values({
        id: claim.id,
        databaseId: claim.resourceId,
        projectId,
        actorId,
        requestId: input.requestId,
        requestIdentity: identity,
        kind: recoveryKind,
        status: "running",
        expectedRevision: input.expectedRevision,
        claimToken: claim.token,
        leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS),
        // This inspection intent points only to the saved operation; it is not an SQL command.
        effect: {
          kind: intentKind,
          id: original.id,
          startedAt: new Date().toISOString(),
        },
      });
      return { resource };
    });
    if (admittedResource.replay) return admittedResource.replay;
    admitted = true;
    const resource = admittedResource.resource;
    if (
      !resource ||
      (resource.environment === "development" && !resource.runtimeIdentity)
    )
      throw new AppDatabaseError(
        409,
        "Saved database identity is unavailable.",
      );
    heartbeat = setInterval(() => {
      if (!renewal)
        renewal = renewDatabaseAction(database, claim)
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            renewal = undefined;
          });
    }, HEARTBEAT_MS);
    const assertLocalHeld = (): void => {
      lock.assertHeld();
      if (lost || Date.now() > deadline)
        throw new AppDatabaseError(
          409,
          "Database recovery deadline or lease expired.",
        );
    };
    const assertHeld = async (): Promise<void> => {
      assertLocalHeld();
      await assertDatabaseCleanupLease(database, claim);
      if (
        !(await readProjectCapabilities(database, projectId, actorId))?.manage
      )
        throw new AppDatabaseError(403, "Recovery authority changed.");
      assertLocalHeld();
    };
    const scope = {
      resourceId: claim.resourceId,
      projectId,
      environment: resource.environment,
    };
    const cleanup = {
      kind: "cleanup-read-runtime" as const,
      id: `wrenly-database-read-${original.id}`,
    };
    await assertHeld();
    if (strategy) {
      await strategy.cleanup({ database, claim, original, assertHeld });
      await strategy.inspect({ resource, original, assertHeld });
    } else {
      await recordDatabaseCleanupEffect(database, claim, cleanup);
      await cleanupAbandonedDatabaseRead(scope, original.id, assertHeld);
      if (
        (resource.environment === "production" && production
          ? await inspectProductionResourceState(
              database,
              projectId,
              actorId,
              resource.id,
              resource.revision,
              production,
            )
          : await inspectManagedDatabaseState(
              { ...scope, environment: "development" },
              resource.runtimeIdentity!,
            )) !== "ready"
      )
        throw new AppDatabaseError(
          409,
          "The saved database is not ready. Its recovery fence is preserved.",
        );
      await assertHeld();
      await acknowledgeDatabaseCleanupEffect(database, claim, cleanup.id);
    }
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      const [current] = await tx
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.id, claim.resourceId),
            eq(appDatabases.projectId, projectId),
          ),
        )
        .for("update");
      const [recovery] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .for("update");
      const [target] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(eq(appDatabaseOperations.id, original.id))
        .for("update");
      if (
        !current ||
        current.revision !== input.expectedRevision ||
        current.status !== "recovery_required" ||
        current.provider !== resource.provider ||
        current.environment !== resource.environment ||
        JSON.stringify(current.providerIdentity) !==
          JSON.stringify(resource.providerIdentity) ||
        JSON.stringify(current.runtimeIdentity) !==
          JSON.stringify(resource.runtimeIdentity) ||
        !recovery ||
        !pointsToRead(recovery, original.id) ||
        recovery.cleanupEffect ||
        !(strategy
          ? recovery.completedCleanupEffects.some(
              (effect) =>
                effect.kind === "cleanup-production-operation" &&
                effect.id === original.id,
            )
          : recovery.completedCleanupEffects.some(
              (effect) =>
                effect.kind === cleanup.kind && effect.id === cleanup.id,
            )) ||
        target?.status !== "interrupted"
      )
        throw new AppDatabaseError(
          409,
          "Database recovery state changed. Its blocker is preserved.",
        );
      validate(target);
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
        pending.length > MAX_RECOVERY_ATTEMPTS ||
        pending.some(
          (row) =>
            row.id !== original.id &&
            row.id !== claim.id &&
            !pointsToRead(row, original.id),
        )
      )
        throw new AppDatabaseError(
          409,
          "Another database action requires review.",
        );
      // The transaction already locked the exact live claim above. Borrowing another
      // pool connection here can deadlock a small installation's connection pool.
      assertLocalHeld();
      for (const row of pending.filter((row) => row.id !== claim.id)) {
        // Provider-specific verified outcomes are saved separately; cleanup never claims old SQL succeeded.
        await tx
          .update(appDatabaseOperations)
          .set({
            status: "failed",
            errorCode: strategy
              ? "RECOVERED_PRODUCTION_CLEANUP"
              : "RECOVERED_READ_CLEANUP",
            claimToken: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          })
          .where(eq(appDatabaseOperations.id, row.id));
      }
      if (strategy?.finish) await strategy.finish(tx, target);
      const finished = await tx
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
      if (!finished.length)
        throw new AppDatabaseError(
          409,
          "Recovery lease expired before confirmation.",
        );
      const restored = await tx
        .update(appDatabases)
        .set({
          status: "ready",
          revision: crypto.randomUUID(),
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(appDatabases.id, claim.resourceId),
            eq(appDatabases.revision, input.expectedRevision),
          ),
        )
        .returning({ id: appDatabases.id });
      if (!restored.length)
        throw new AppDatabaseError(
          409,
          "Database revision changed before recovery confirmation.",
        );
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
      "Reader recovery could not be confirmed. Check this action before reviewing another attempt.",
    );
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (renewal) await renewal;
    await lock.release();
  }
}

/** Returns only safe recovery errors; request replay never repeats cleanup implicitly. */
export async function recoverDatabaseRead(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
  production?: ProductionRecoveryTarget,
): Promise<RecoveryResult> {
  try {
    return await executeDatabaseCleanupRecovery(
      database,
      projectId,
      actorId,
      body,
      production,
    );
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "Reader recovery could not be confirmed. Check its action status before trying again.",
    );
  }
}
