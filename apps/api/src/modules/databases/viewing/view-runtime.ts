/**
 * COMPONENT: Fenced read-only runtime
 * PURPOSE: Run one bounded reader query and close its socket before releasing its claim.
 * INPUTS: Active actor, explicit resource request and cancellation signal.
 * OUTPUTS: Bounded helper result after cleanup; no rows stored in control tables.
 * STEPS: Load trusted helper, admit lease, take resource kernel lock, renew lease,
 * resolve only reader credentials, run socket/query helpers, cleanup, finish claim.
 * EDGE CASES: Authority/lease loss aborts execution; unknown effects stay interrupted.
 * ERROR STATES: Cleanup failure suppresses data and preserves the recovery fence.
 */
import type { db } from "@wrenly/db";
import {
  startDatabaseSocket,
  cleanupScopedDatabaseSocket,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import { runDatabaseSocketWorker } from "@wrenly/sandbox/database-socket-worker";
import {
  acquireDatabaseExecutorLock,
  type DatabaseExecutorLock,
} from "../database-executor-lock";
import { getDatabaseWorkerBundle } from "../database-worker-bundle";
import {
  renewDatabaseAction,
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  interruptDatabaseAction,
  assertDatabaseCleanupLease,
  recordDatabaseCleanupEffect,
  acknowledgeDatabaseCleanupEffect,
} from "../database-store";
import {
  beginDatabaseRead,
  assertDatabaseRead,
  finishDatabaseRead,
  loadDatabaseReadConnection,
} from "./view-leases";
import { AppDatabaseError } from "../database-contract";

const READ_DEADLINE_MS = 60_000;
const RENEWAL_INTERVAL_MS = 5000;

/** Internal adapter only; Production/private-target reads require their own verified adapter. */
export async function runDatabaseViewQuery(
  database: typeof db,
  directory: string,
  projectId: string,
  actorId: string,
  value: unknown,
  callerSignal: AbortSignal,
): Promise<unknown> {
  const bundle = await getDatabaseWorkerBundle("query");
  callerSignal.throwIfAborted();
  const claim = await beginDatabaseRead(database, projectId, actorId, value);
  const abort = new AbortController();
  const signal = AbortSignal.any([
    callerSignal,
    abort.signal,
    AbortSignal.timeout(READ_DEADLINE_MS),
  ]);
  let lock: DatabaseExecutorLock | undefined;
  let renewal: Promise<void> | undefined;
  let socketIntent = false;
  let output: unknown;
  let failed = false;
  const heartbeat = setInterval(() => {
    if (!renewal)
      renewal = renewDatabaseAction(database, claim)
        .catch(() => abort.abort())
        .finally(() => {
          renewal = undefined;
        });
  }, RENEWAL_INTERVAL_MS);
  const scope = {
    resourceId: claim.resourceId,
    projectId,
    environment: "development" as const,
  };
  try {
    lock = await acquireDatabaseExecutorLock(claim);
    const connection = await loadDatabaseReadConnection(
      database,
      claim,
      directory,
    );
    const fence: DatabaseRuntimeFence = {
      assertHeld: async () => {
        lock?.assertHeld();
        signal.throwIfAborted();
        await assertDatabaseRead(database, claim);
        lock?.assertHeld();
        signal.throwIfAborted();
      },
      beforeEffect: async (effect) => {
        if (effect.kind === "create-socket") socketIntent = true;
        await recordDatabaseEffect(database, claim, effect);
      },
      acknowledgeEffect: (effect) =>
        acknowledgeDatabaseEffect(database, claim, effect.id),
    };
    const socket = await startDatabaseSocket({
      scope,
      database: connection.identity,
      socketId: claim.id,
      role: { kind: "reader", ...connection.role },
      fence,
      signal,
    });
    output = await runDatabaseSocketWorker({
      kind: "query",
      scope,
      socket,
      operationId: claim.id,
      request: {
        resourceId: claim.resourceId,
        ...connection.role,
        rows: claim.request.rows,
        ...(claim.request.table === undefined
          ? {}
          : { table: claim.request.table }),
        ...(claim.request.after === undefined
          ? {}
          : { after: claim.request.after }),
      },
      bundle,
      fence,
      signal,
    });
    await assertDatabaseRead(database, claim);
    signal.throwIfAborted();
  } catch {
    failed = true;
  } finally {
    try {
      // Cleanup is deliberately independent of the browser's cancelled signal.
      if (socketIntent) {
        lock?.assertHeld();
        await assertDatabaseCleanupLease(database, claim);
        const cleanup = {
          kind: "close-reader-socket" as const,
          id: `wrenly-database-socket-${claim.id}`,
        };
        await recordDatabaseCleanupEffect(database, claim, cleanup);
        lock?.assertHeld();
        await assertDatabaseCleanupLease(database, claim);
        await cleanupScopedDatabaseSocket(scope, claim.id);
        lock?.assertHeld();
        await acknowledgeDatabaseCleanupEffect(database, claim, cleanup.id);
      }
      await finishDatabaseRead(database, claim, !failed);
    } catch {
      failed = true;
      await interruptDatabaseAction(database, claim);
    } finally {
      clearInterval(heartbeat);
      if (renewal) await renewal;
      await lock?.release();
    }
  }
  if (failed)
    throw new AppDatabaseError(
      503,
      "Database inspection failed or requires cleanup. Reload its current status.",
    );
  return output;
}
