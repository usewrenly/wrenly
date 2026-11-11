/** Executes separately journalled project SQL phases; importing it starts no background loop. */
import { attachProductionProjectResource } from "./resource-store";
import type { DatabaseAddressLookup } from "../target-policy";
import type { db } from "@wrenly/db";
import { type ProductionProvisionPhase } from "@wrenly/db/production-project-credentials";
import {
  createProductionProjectRoles,
  createProductionProjectDatabase,
  enableProductionProjectConnections,
  initializeProductionProjectSchema,
} from "@wrenly/db/production-project-provisioning";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import { withPinnedProductionManagement } from "../management-connection";
import { readControlIdentity } from "../setup/verification-worker";
import {
  claimProjectProductionProvision,
  beginProjectProductionPhase,
  finishProjectProductionPhase,
  type ProjectProvisionReceipt,
} from "./store";
import { executeProjectProductionProvision } from "./executor";
const RUN_PHASE = {
  roles: createProductionProjectRoles,
  database: createProductionProjectDatabase,
  connections: enableProductionProjectConnections,
  schema: initializeProductionProjectSchema,
} satisfies Record<
  ProductionProvisionPhase,
  typeof createProductionProjectRoles
>;
/** Holds the resource lock across saved intent, verified SQL and independently saved phase acknowledgement. */
export async function runProjectProductionProvisionOnce(input: {
  database: typeof db;
  directory: string;
  controlDatabaseUrl: string;
  signal: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<ProjectProvisionReceipt | null> {
  input.signal.throwIfAborted();
  const claim = await claimProjectProductionProvision(input.database);
  if (!claim) return null;
  const lock = await acquireDatabaseExecutorLock({
    id: claim.id,
    resourceId: claim.id,
    projectId: claim.projectId,
    token: claim.token,
  });
  try {
    const receipt = await executeProjectProductionProvision(
      claim,
      {
        assertHeld: () => lock.assertHeld(),
        begin: (current, phase) =>
          beginProjectProductionPhase(
            input.database,
            current,
            phase,
            input.directory,
          ),
        run: async (phase, saved) => {
          const controlClusterId = await readControlIdentity(input.database);
          lock.assertHeld();
          input.signal.throwIfAborted();
          const target = {
            target: {
              ...saved.server.target,
              database:
                phase === "schema"
                  ? saved.credentials.database
                  : saved.server.target.database,
            },
            addresses: saved.server.addresses,
          };
          await withPinnedProductionManagement({
            target,
            credential: saved.server.credential,
            certificateAuthority: saved.server.certificateAuthority,
            controlDatabaseUrl: input.controlDatabaseUrl,
            signal: input.signal,
            lookup: input.lookup,
            run: async (database) => {
              lock.assertHeld();
              input.signal.throwIfAborted();
              await RUN_PHASE[phase](
                database,
                { appClusterId: saved.server.clusterId, controlClusterId },
                claim.id,
                saved.credentials,
              );
            },
          });
        },
        finish: (current, phase, confirmed) =>
          finishProjectProductionPhase(
            input.database,
            current,
            phase,
            confirmed,
          ),
      },
      input.signal,
    );
    if (receipt.status === "created") {
      lock.assertHeld();
      input.signal.throwIfAborted();
      // The next worker may claim the resource as soon as attachment commits.
      // SQL is already acknowledged; release its kernel lock before publishing that claim.
      await lock.release();
      await attachProductionProjectResource({
        database: input.database,
        directory: input.directory,
        projectId: claim.projectId,
        provisionId: claim.id,
        principal: claim.principal,
      });
      return { ...receipt, status: "attached" };
    }
    return receipt;
  } finally {
    await lock.release();
  }
}
