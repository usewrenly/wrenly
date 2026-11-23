/** Owner-confirmed per-project pause/resume; never stops the shared PostgreSQL server. */
import type { db } from "@wrenly/db";
import { setProductionProjectAvailability } from "@wrenly/db/production-project-provisioning";
import { verifyProductionProjectPolicy } from "@wrenly/db/production-project-recovery";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import { accessContext } from "../../../auth/access/access-context";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import {
  assertDatabaseExecution,
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  finishDatabaseAction,
  type DatabaseClaim,
} from "../../database-store";
import { loadProductionResourceExecution } from "../project-provisioning/resource-store";
import { readControlIdentity } from "../setup/verification-worker";
import { withPinnedProductionManagement } from "../management-connection";
import type { DatabaseAddressLookup } from "../target-policy";

/** Caller renews the durable lease; an unknown connection change remains interrupted, never silently repeated. */
export async function executeProductionResourceAvailability(input: {
  database: typeof db;
  claim: DatabaseClaim;
  directory: string;
  controlDatabaseUrl: string;
  signal: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<"success"> {
  const { database, claim, signal } = input;
  const lock = await acquireDatabaseExecutorLock(claim);
  try {
    const saved = await loadProductionResourceExecution(
      database,
      claim,
      input.directory,
    );
    return await accessContext.run({ principal: saved.principal }, async () => {
      const kind = saved.operation.kind;
      if (
        (kind !== "start" && kind !== "stop") ||
        saved.resource.status !== (kind === "start" ? "stopped" : "ready") ||
        saved.resource.revision !== saved.operation.expectedRevision
      )
        throw new Error(
          "Reload the confirmed Production database state before changing availability.",
        );
      const binding = parseProductionResourceBinding(
        claim.resourceId,
        saved.resource.providerIdentity,
      );
      const identity = {
        appClusterId: binding.clusterId,
        controlClusterId: await readControlIdentity(database),
      };
      const assertHeld = async (): Promise<void> => {
        lock.assertHeld();
        signal.throwIfAborted();
        await assertDatabaseExecution(database, claim);
        lock.assertHeld();
        signal.throwIfAborted();
      };
      const verify = async (): Promise<void> => {
        await assertHeld();
        await withPinnedProductionManagement({
          target: {
            target: { ...saved.server.target, database: binding.database },
            addresses: saved.server.addresses,
          },
          credential: saved.server.credential,
          certificateAuthority: saved.server.certificateAuthority,
          controlDatabaseUrl: input.controlDatabaseUrl,
          signal,
          lookup: input.lookup,
          run: async (connection) => {
            await verifyProductionProjectPolicy(
              connection,
              identity,
              claim.resourceId,
              saved.credentials,
            );
            if (
              (await inspectAppDatabaseSchema(connection)) !==
              saved.resource.schemaDigest
            )
              throw new Error("Production schema changed while stopped.");
          },
        });
      };
      if (kind === "stop") await verify();
      const effect = { kind, id: `production-availability-${claim.id}` } as const;
      await assertHeld();
      await recordDatabaseEffect(database, claim, effect);
      await assertHeld();
      await withPinnedProductionManagement({
        target: {
          target: saved.server.target,
          addresses: saved.server.addresses,
        },
        credential: saved.server.credential,
        certificateAuthority: saved.server.certificateAuthority,
        controlDatabaseUrl: input.controlDatabaseUrl,
        signal,
        lookup: input.lookup,
        run: (connection) =>
          setProductionProjectAvailability(
            connection,
            identity,
            claim.resourceId,
            saved.credentials,
            kind === "start",
          ),
      });
      await assertHeld();
      await acknowledgeDatabaseEffect(database, claim, effect.id);
      if (kind === "start") await verify();
      await assertHeld();
      await finishDatabaseAction(database, claim, { success: true });
      return "success" as const;
    });
  } finally {
    await lock.release();
  }
}
