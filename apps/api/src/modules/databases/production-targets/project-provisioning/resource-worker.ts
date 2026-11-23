/** Verifies a newly provisioned Production resource before the ordinary resource journal can mark it ready. */
import { accessContext } from "../../../auth/access/access-context";
import type { db } from "@wrenly/db";
import { inspectProductionProjectPhase } from "@wrenly/db/production-project-recovery";
import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import { createProductionDatabaseNetwork } from "@wrenly/sandbox/production-database-network";
import {
  startProductionDatabaseSocket,
  cleanupScopedDatabaseSocket,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import { runDatabaseSocketWorker } from "@wrenly/sandbox/database-socket-worker";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
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
import { getDatabaseWorkerBundle } from "../../database-worker-bundle";
import { withPinnedProductionManagement } from "../management-connection";
import { readControlIdentity } from "../setup/verification-worker";
import type { DatabaseAddressLookup } from "../target-policy";
import {
  loadProductionResourceExecution,
  saveProductionResourceNetwork,
  saveProductionResourceSchema,
} from "./resource-store";
/** Caller owns lease renewal; failure leaves the saved operation blocked, never reruns SQL or replaces role passwords. */
export async function executeProductionResourceCreation(input: {
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
        saved.operation.kind !== "create" ||
        saved.resource.status !== "provisioning" ||
        saved.resource.providerIdentity?.networkId
      )
        throw new Error(
          "Production resource requires inspection before creation.",
        );
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
      const controlClusterId = await readControlIdentity(database);
      const target = {
        target: {
          ...saved.server.target,
          database: saved.credentials.database,
        },
        addresses: saved.server.addresses,
      };
      const verify = async (): Promise<string> => {
        await fence.assertHeld();
        let stage = "connection";
        try {
          return await withPinnedProductionManagement({
            target,
            credential: saved.server.credential,
            certificateAuthority: saved.server.certificateAuthority,
            controlDatabaseUrl: input.controlDatabaseUrl,
            signal,
            lookup: input.lookup,
            run: async (connection) => {
              stage = "role policy";
              if (
                (await inspectProductionProjectPhase(
                  connection,
                  { appClusterId: saved.server.clusterId, controlClusterId },
                  claim.resourceId,
                  saved.credentials,
                  "schema",
                )) !== "confirmed"
              )
                throw new Error("Production project role policy changed.");
              stage = "schema inspection";
              const digest = await inspectAppDatabaseSchema(connection);
              stage = "connection closure";
              return digest;
            },
          });
        } catch {
          throw new Error(
            `Production readiness could not confirm ${stage}. Inspect the saved operation.`,
          );
        }
      };
      const roleEffect = {
        kind: "provision-roles" as const,
        id: `verify-production-roles-${claim.id}`,
      };
      await fence.beforeEffect(roleEffect);
      const schemaDigest = await verify();
      await fence.acknowledgeEffect(roleEffect);
      const networkId = await createProductionDatabaseNetwork({
        scope,
        fence,
        signal,
        saveIdentity: (id) =>
          saveProductionResourceNetwork(database, claim, id),
      });
      const address = saved.server.addresses[0];
      if (!address)
        throw new Error("Production target has no pinned private address.");
      const socket = await startProductionDatabaseSocket({
        scope,
        socketId: claim.id,
        networkId,
        upstream: {
          hostname: saved.server.target.host,
          address,
          port: saved.server.target.port,
        },
        credentials: saved.credentials,
        role: "reader",
        certificateAuthority: saved.server.certificateAuthority,
        fence,
        signal,
        verifyTarget: async () => {
          if ((await verify()) !== schemaDigest)
            throw new Error("Production schema changed during readiness.");
        },
      });
      try {
        await runDatabaseSocketWorker({
          kind: "query",
          scope,
          socket,
          operationId: claim.id,
          request: {
            resourceId: claim.resourceId,
            ...saved.credentials.reader,
            rows: false,
          },
          bundle: await getDatabaseWorkerBundle("query"),
          fence,
          signal,
        });
        await fence.assertHeld();
      } finally {
        await closeSocket();
      }
      if ((await verify()) !== schemaDigest)
        throw new Error(
          "Production schema changed before readiness completion.",
        );
      await saveProductionResourceSchema(database, claim, schemaDigest);
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
    const effect = {
      kind: "close-reader-socket" as const,
      id: `wrenly-database-socket-${claim.id}`,
    };
    await recordDatabaseCleanupEffect(database, claim, effect);
    lock.assertHeld();
    await assertDatabaseCleanupLease(database, claim);
    await cleanupScopedDatabaseSocket(scope, claim.id);
    await acknowledgeDatabaseCleanupEffect(database, claim, effect.id);
    socketStarted = false;
  }
}
