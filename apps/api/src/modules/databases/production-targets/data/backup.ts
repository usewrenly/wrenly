/** Production archives use the same sealed, disposable-restore proof as Development; no live restore is exposed. */
import type { db } from "@wrenly/db";
import { verifyProductionProjectPolicy } from "@wrenly/db/production-project-recovery";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import {
  startProductionDatabaseSocket,
  cleanupScopedDatabaseSocket,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import { captureProductionDatabaseBackup } from "@wrenly/sandbox/database-backup-runtime";
import { accessContext } from "../../../auth/access/access-context";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import { getDatabaseWorkerBundle } from "../../database-worker-bundle";
import { verifyCapturedDatabaseBackup } from "../../database-backup-executor";
import {
  assertDatabaseExecution,
  assertDatabaseCleanupLease,
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  recordDatabaseCleanupEffect,
  acknowledgeDatabaseCleanupEffect,
  saveVerifiedDatabaseBackup,
  finishDatabaseAction,
  type DatabaseClaim,
} from "../../database-store";
import { loadProductionResourceExecution } from "../project-provisioning/resource-store";
import { readControlIdentity } from "../setup/verification-worker";
import { withPinnedProductionManagement } from "../management-connection";
import type { DatabaseAddressLookup } from "../target-policy";
/** Caller renews the durable claim; completion follows encrypted restore verification and independent source-socket cleanup. */
export async function executeProductionResourceBackup(input: {
  database: typeof db;
  claim: DatabaseClaim;
  directory: string;
  controlDatabaseUrl: string;
  signal: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<"success"> {
  const { database, claim, signal } = input;
  const lock = await acquireDatabaseExecutorLock(claim);
  const scope = {
    resourceId: claim.resourceId,
    projectId: claim.projectId,
    environment: "production" as const,
  };
  let socketStarted = false;
  try {
    const saved = await loadProductionResourceExecution(
      database,
      claim,
      input.directory,
    );
    return await accessContext.run({ principal: saved.principal }, async () => {
      if (
        saved.operation.kind !== "backup" ||
        saved.resource.status !== "ready" ||
        saved.resource.revision !== saved.operation.expectedRevision
      )
        throw new Error(
          "Production backup requires the confirmed ready revision.",
        );
      const binding = parseProductionResourceBinding(
        claim.resourceId,
        saved.resource.providerIdentity,
      );
      const controlClusterId = await readControlIdentity(database);
      const fence: DatabaseRuntimeFence = {
        assertHeld: async () => {
          lock.assertHeld();
          signal.throwIfAborted();
          await assertDatabaseExecution(database, claim);
          lock.assertHeld();
          signal.throwIfAborted();
        },
        beforeEffect: async (effect) => {
          await fence.assertHeld();
          if (effect.kind === "create-socket") socketStarted = true;
          await recordDatabaseEffect(database, claim, effect);
        },
        acknowledgeEffect: (effect) =>
          acknowledgeDatabaseEffect(database, claim, effect.id),
      };
      const target = {
        target: { ...saved.server.target, database: binding.database },
        addresses: saved.server.addresses,
      };
      const inspect = async (): Promise<string> => {
        await fence.assertHeld();
        return withPinnedProductionManagement({
          target,
          credential: saved.server.credential,
          certificateAuthority: saved.server.certificateAuthority,
          controlDatabaseUrl: input.controlDatabaseUrl,
          signal,
          lookup: input.lookup,
          run: async (connection) => {
            await verifyProductionProjectPolicy(
              connection,
              { appClusterId: binding.clusterId, controlClusterId },
              claim.resourceId,
              saved.credentials,
            );
            return inspectAppDatabaseSchema(connection);
          },
        });
      };
      const address = saved.server.addresses[0];
      if (!address) throw new Error("Missing verified Production target.");
      const socket = await startProductionDatabaseSocket({
        scope,
        socketId: claim.id,
        networkId: binding.networkId,
        upstream: {
          hostname: saved.server.target.host,
          address,
          port: saved.server.target.port,
        },
        credentials: saved.credentials,
        role: "migrator",
        certificateAuthority: saved.server.certificateAuthority,
        fence,
        signal,
        verifyTarget: async () => {
          await inspect();
        },
      });
      let backup: Awaited<ReturnType<typeof verifyCapturedDatabaseBackup>>;
      try {
        backup = await verifyCapturedDatabaseBackup({
          claim,
          directory: input.directory,
          fence,
          signal,
          bundle: await getDatabaseWorkerBundle("administrator"),
          inspect,
          capture: () =>
            captureProductionDatabaseBackup({
              scope,
              socket,
              operationId: claim.id,
              role: saved.credentials.migrator,
              fence,
              signal,
            }),
        });
      } finally {
        await closeSocket();
      }
      await fence.assertHeld();
      await saveVerifiedDatabaseBackup(database, claim, backup);
      await fence.assertHeld();
      await finishDatabaseAction(database, claim, { success: true });
      return "success" as const;
    });
  } finally {
    try {
      if (socketStarted) await closeSocket();
    } finally {
      await lock.release();
    }
  }
  async function closeSocket(): Promise<void> {
    lock.assertHeld();
    await assertDatabaseCleanupLease(database, claim);
    const cleanup = {
      kind: "close-reader-socket" as const,
      id: `wrenly-database-socket-${claim.id}`,
    };
    await recordDatabaseCleanupEffect(database, claim, cleanup);
    lock.assertHeld();
    await assertDatabaseCleanupLease(database, claim);
    await cleanupScopedDatabaseSocket(scope, claim.id);
    await acknowledgeDatabaseCleanupEffect(database, claim, cleanup.id);
    socketStarted = false;
  }
}
