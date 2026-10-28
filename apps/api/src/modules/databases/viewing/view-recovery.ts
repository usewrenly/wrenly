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
type RecoveryResult = {
  operationId: string;
  resourceId: string;
  replayed: boolean;
};

function pointsToRead(operation: Operation, target: string): boolean {
  return (
    operation.kind === "recover-read" &&
    operation.effect?.kind === "inspect-read-operation" &&
    operation.effect.id === target
  );
}
function requireReadEffects(operation: Operation): void {
  const effects = [
    ...operation.completedEffects,
    ...(operation.effect ? [operation.effect] : []),
  ];
  const cleanup = [
    ...operation.completedCleanupEffects,
    ...(operation.cleanupEffect ? [operation.cleanupEffect] : []),
  ];
  if (
    operation.kind !== "read" ||
    effects.length > 2 ||
    cleanup.length > 1 ||
    effects.some(
      (effect) =>
        !(
          (effect.kind === "create-socket" &&
            effect.id === `wrenly-database-socket-${operation.id}`) ||
          (effect.kind === "read-database" &&
            effect.id === `wrenly-database-query-${operation.id}`)
        ),
    ) ||
    cleanup.some(
      (effect) =>
        effect.kind !== "close-reader-socket" ||
        effect.id !== `wrenly-database-socket-${operation.id}`,
    )
  )
    throw new AppDatabaseError(
      409,
      "This operation is not a bounded reader cleanup. Preserve its recovery fence.",
    );
}

/** Explicit cleanup only; it never reopens a socket, returns rows or acknowledges old SQL. */
async function executeReadRecovery(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<RecoveryResult> {
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
    .update(JSON.stringify([projectId, "recover-read", input]))
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
      row.kind !== "recover-read" ||
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
  if (!original) throw new AppDatabaseError(404, "Database read not found.");
  requireReadEffects(original);
  const claim: DatabaseClaim = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    resourceId: original.databaseId,
    projectId,
  };
  const lock = await acquireDatabaseExecutorLock(claim).catch(() => {
    throw new AppDatabaseError(
      409,
      "The previous reader is still cleaning up. Wait before reviewing recovery again.",
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
        .select({
          id: appDatabases.id,
          revision: appDatabases.revision,
          status: appDatabases.status,
          provider: appDatabases.provider,
          environment: appDatabases.environment,
          identity: appDatabases.runtimeIdentity,
        })
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
        !resource?.identity ||
        resource.revision !== input.expectedRevision ||
        resource.status !== "recovery_required" ||
        resource.provider !== "local" ||
        resource.environment !== "development" ||
        target?.status !== "interrupted"
      )
        throw new AppDatabaseError(
          409,
          "Review the current interrupted local database read before recovery.",
        );
      requireReadEffects(target);
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
          "Another database operation still needs attention before reader recovery.",
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
        kind: "recover-read",
        status: "running",
        expectedRevision: input.expectedRevision,
        claimToken: claim.token,
        leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS),
        // This inspection intent points only to the saved read; it is not an SQL command.
        effect: {
          kind: "inspect-read-operation",
          id: original.id,
          startedAt: new Date().toISOString(),
        },
      });
      return { resource };
    });
    if (admittedResource.replay) return admittedResource.replay;
    admitted = true;
    const resource = admittedResource.resource;
    if (!resource?.identity)
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
    const assertHeld = async (): Promise<void> => {
      lock.assertHeld();
      if (lost || Date.now() > deadline)
        throw new AppDatabaseError(
          409,
          "Reader recovery deadline or lease expired.",
        );
      await assertDatabaseCleanupLease(database, claim);
      lock.assertHeld();
    };
    const scope = {
      resourceId: claim.resourceId,
      projectId,
      environment: "development" as const,
    };
    const cleanup = {
      kind: "cleanup-read-runtime" as const,
      id: `wrenly-database-read-${original.id}`,
    };
    await assertHeld();
    await recordDatabaseCleanupEffect(database, claim, cleanup);
    await cleanupAbandonedDatabaseRead(scope, original.id, assertHeld);
    if (
      (await inspectManagedDatabaseState(scope, resource.identity!)) !== "ready"
    )
      throw new AppDatabaseError(
        409,
        "The saved database is not ready. Its recovery fence is preserved.",
      );
    await assertHeld();
    await acknowledgeDatabaseCleanupEffect(database, claim, cleanup.id);
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
        JSON.stringify(current.runtimeIdentity) !==
          JSON.stringify(resource.identity) ||
        !recovery ||
        !pointsToRead(recovery, original.id) ||
        recovery.cleanupEffect ||
        !recovery.completedCleanupEffects.some(
          (effect) => effect.kind === cleanup.kind && effect.id === cleanup.id,
        ) ||
        target?.status !== "interrupted"
      )
        throw new AppDatabaseError(
          409,
          "Database recovery state changed. Its blocker is preserved.",
        );
      requireReadEffects(target);
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
      await assertHeld();
      for (const row of pending.filter((row) => row.id !== claim.id)) {
        // Preserve the original unknown effect: closure never claims its query succeeded.
        await tx
          .update(appDatabaseOperations)
          .set({
            status: "failed",
            errorCode: "RECOVERED_READ_CLEANUP",
            claimToken: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          })
          .where(eq(appDatabaseOperations.id, row.id));
      }
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
): Promise<RecoveryResult> {
  try {
    return await executeReadRecovery(database, projectId, actorId, body);
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "Reader recovery could not be confirmed. Check its action status before trying again.",
    );
  }
}
