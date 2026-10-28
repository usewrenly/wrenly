import { getDatabaseWorkerBundle } from "./database-worker-bundle";
import { executeReviewedDatabaseMigrations } from "./database-migration-executor";
import { executeManagedDatabaseBackup } from "./database-backup-executor";
// Explicit opt-in host composition starts this executor; importing it never claims work.
import type { db } from "@wrenly/db";
import {
  createManagedDatabase,
  DatabaseRuntimeError,
  setManagedDatabaseRunning,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import { provisionManagedDatabaseRoles } from "@wrenly/sandbox/database-administrator";
import { verifyDatabaseToolchain } from "@wrenly/sandbox/database-toolchain";
import { acquireDatabaseExecutorLock } from "./database-executor-lock";
import { startDatabaseWorker } from "./database-worker";
import {
  claimDatabaseAction,
  renewDatabaseAction,
  interruptExpiredDatabaseActions,
  loadDatabaseExecution,
  assertDatabaseExecution,
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  finishDatabaseAction,
  saveVerifiedDatabaseBackup,
  interruptDatabaseAction,
  assertDatabaseCleanupLease,
  recordDatabaseCleanupEffect,
  acknowledgeDatabaseCleanupEffect,
} from "./database-store";
import { logger } from "../../lib/logger";
/** Explicit factory only: no import-time worker, provisioning, migration or credential side effects. */
export function createProductionDatabaseWorker(
  database: typeof db,
  dataDirectory: string,
): { stop: () => Promise<void> } {
  return startDatabaseWorker({
    claim: () => claimDatabaseAction(database),
    renew: (claim) => renewDatabaseAction(database, claim),
    recoverExpired: () => interruptExpiredDatabaseActions(database),
    interrupt: (claim) => interruptDatabaseAction(database, claim),
    log: (message, context) => logger.info(message, context),
    execute: async (claim, signal) => {
      const lock = await acquireDatabaseExecutorLock(claim);
      try {
        const execution = await loadDatabaseExecution(
          database,
          claim,
          dataDirectory,
        );
        const fence: DatabaseRuntimeFence = {
          assertHeld: async () => {
            lock.assertHeld();
            signal.throwIfAborted();
            await assertDatabaseExecution(database, claim);
            lock.assertHeld();
            signal.throwIfAborted();
          },
          beforeEffect: (effect) =>
            recordDatabaseEffect(database, claim, effect),
          acknowledgeEffect: (effect, identity) =>
            acknowledgeDatabaseEffect(database, claim, effect.id, identity),
        };
        await fence.assertHeld();
        const scope = {
          resourceId: claim.resourceId,
          projectId: claim.projectId,
          environment: "development" as const,
        };
        if (
          execution.resource.environment !== "development" ||
          execution.resource.provider !== "local"
        )
          throw new Error("Unsupported database provider");
        if (execution.operation.kind === "create") {
          let bundle: Uint8Array;
          try {
            await verifyDatabaseToolchain();
            bundle = await getDatabaseWorkerBundle("administrator");
          } catch {
            await fence.assertHeld();
            await lock.release();
            await finishDatabaseAction(database, claim, {
              success: false,
              errorCode: "PREREQUISITE_UNAVAILABLE",
            });
            return "failed";
          }
          const identity = await createManagedDatabase({
            scope,
            operationId: claim.id,
            administrator: execution.credentials.administrator,
            fence,
            signal,
          });
          await provisionManagedDatabaseRoles({
            scope,
            database: identity,
            operationId: claim.id,
            credentials: execution.credentials,
            administratorBundle: bundle,
            fence,
            signal,
          });
        } else if (execution.operation.kind === "migrate") {
          await verifyDatabaseToolchain();
          const cleanupFence: DatabaseRuntimeFence = {
            assertHeld: async () => {
              lock.assertHeld();
              await assertDatabaseCleanupLease(database, claim);
              lock.assertHeld();
            },
            beforeEffect: async (effect) => {
              if (effect.kind !== "terminate-sessions")
                throw new Error("Unsupported cleanup effect");
              await recordDatabaseCleanupEffect(database, claim, {
                kind: "terminate-sessions",
                id: effect.id,
              });
            },
            acknowledgeEffect: (effect) =>
              acknowledgeDatabaseCleanupEffect(database, claim, effect.id),
          };
          await executeReviewedDatabaseMigrations({
            database,
            claim,
            execution,
            directory: dataDirectory,
            administratorBundle: await getDatabaseWorkerBundle("administrator"),
            migrationBundle: await getDatabaseWorkerBundle("migration"),
            fence,
            cleanupFence,
            signal,
          });
        } else if (execution.operation.kind === "backup") {
          await verifyDatabaseToolchain();
          const backup = await executeManagedDatabaseBackup({
            claim,
            execution,
            directory: dataDirectory,
            bundle: await getDatabaseWorkerBundle("administrator"),
            fence,
            signal,
          });
          await saveVerifiedDatabaseBackup(database, claim, backup);
        } else if (
          execution.operation.kind === "start" ||
          execution.operation.kind === "stop"
        ) {
          if (!execution.resource.runtimeIdentity)
            throw new Error("Saved database identity missing");
          await setManagedDatabaseRunning(
            scope,
            execution.resource.runtimeIdentity,
            execution.operation.kind === "start",
            fence,
            signal,
          );
        } else throw new Error("Reviewed migration execution is not connected");
        await fence.assertHeld();
        // External effects and helper cleanup are complete. Keep the durable
        // running reservation until commit, but release the kernel lock before
        // publishing ready so another API cannot observe ready with an old lock.
        await lock.release();
        await finishDatabaseAction(database, claim, { success: true });
        return "success";
      } catch (error) {
        logger.error("Database operation failed", {
          operationId: claim.id,
          projectId: claim.projectId,
          stage:
            error instanceof DatabaseRuntimeError ? error.phase : "execution",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      } finally {
        await lock.release();
      }
    },
  });
}
