/** Reviewed Production migrations rehearse a verified archive before touching the exact original project database. */
import type { db } from "@wrenly/db";
import { verifyProductionProjectPolicy } from "@wrenly/db/production-project-recovery";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import {
  startProductionDatabaseSocket,
  cleanupScopedDatabaseSocket,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import {
  enforceProductionDatabaseRolePolicy,
  terminateProductionDatabaseSessions,
} from "@wrenly/db/app-database-roles";
import { accessContext } from "../../../auth/access/access-context";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import { getDatabaseWorkerBundle } from "../../database-worker-bundle";
import { executeFrozenDatabaseMigrations } from "../../database-migration-executor";
import {
  assertDatabaseExecution,
  assertDatabaseCleanupLease,
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  recordDatabaseCleanupEffect,
  acknowledgeDatabaseCleanupEffect,
  finishDatabaseAction,
  type DatabaseClaim,
} from "../../database-store";
import { loadProductionResourceExecution } from "../project-provisioning/resource-store";
import { readControlIdentity } from "../setup/verification-worker";
import { withPinnedProductionManagement } from "../management-connection";
import type { DatabaseAddressLookup } from "../target-policy";
const CLEANUP_TIMEOUT_MS = 20_000;
/** Caller renews the durable claim; SQL uncertainty and client cleanup retain separate acknowledgements. */
export async function executeProductionResourceMigrations(input: {
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
        saved.operation.kind !== "migrate" ||
        saved.resource.status !== "ready" ||
        saved.resource.revision !== saved.operation.expectedRevision
      )
        throw new Error(
          "Production migration requires the confirmed ready revision.",
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
      await executeFrozenDatabaseMigrations({
        database,
        claim,
        directory: input.directory,
        signal,
        fence,
        scope,
        role: saved.credentials.migrator,
        administratorBundle: await getDatabaseWorkerBundle("administrator"),
        migrationBundle: await getDatabaseWorkerBundle("migration"),
        inspect,
        enforcePolicy: async () => {
          const effect = {
            kind: "enforce-policy" as const,
            id: `production-policy-${claim.id}`,
          };
          await fence.beforeEffect(effect);
          await withPinnedProductionManagement({
            target,
            credential: saved.server.credential,
            certificateAuthority: saved.server.certificateAuthority,
            controlDatabaseUrl: input.controlDatabaseUrl,
            signal,
            lookup: input.lookup,
            run: (connection) =>
              enforceProductionDatabaseRolePolicy(
                connection,
                { appClusterId: binding.clusterId, controlClusterId },
                claim.resourceId,
                saved.credentials,
              ),
          });
          await fence.acknowledgeEffect(effect);
        },
        openSocket: (socketFence) =>
          startProductionDatabaseSocket({
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
            fence: socketFence,
            signal,
            verifyTarget: async () => {
              await inspect();
            },
          }),
        closeSocket: async () => {
          await closeSocket();
          const cleanup = {
            kind: "terminate-sessions" as const,
            id: `wrenly-database-administrator-${claim.id}`,
          };
          lock.assertHeld();
          await assertDatabaseCleanupLease(database, claim);
          await recordDatabaseCleanupEffect(database, claim, cleanup);
          await withPinnedProductionManagement({
            target,
            credential: saved.server.credential,
            certificateAuthority: saved.server.certificateAuthority,
            controlDatabaseUrl: input.controlDatabaseUrl,
            signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
            lookup: input.lookup,
            run: (connection) =>
              terminateProductionDatabaseSessions(
                connection,
                { appClusterId: binding.clusterId, controlClusterId },
                claim.resourceId,
                saved.credentials,
                "migrator",
              ),
          });
          lock.assertHeld();
          await assertDatabaseCleanupLease(database, claim);
          await acknowledgeDatabaseCleanupEffect(database, claim, cleanup.id);
        },
      });
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
