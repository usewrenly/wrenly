/** Read-only inspection of the original Production target; never reruns an availability change. */
import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import {
  appDatabases,
  productionDatabaseProvisions,
  productionDatabaseConnections,
  type db,
} from "@wrenly/db";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { validateProductionProjectCredentials } from "@wrenly/db/production-project-credentials";
import { inspectProductionProjectAvailability } from "@wrenly/db/production-project-provisioning";
import { verifyProductionProjectPolicy } from "@wrenly/db/production-project-recovery";
import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import { readProjectCapabilities } from "../../../projects/access/project-access";
import { loadDatabaseKey, decryptDatabaseSecret } from "../../database-secrets";
import { openProductionConnection } from "../instance/credentials";
import { readControlIdentity } from "../setup/verification-worker";
import { withPinnedProductionManagement } from "../management-connection";
import type { DatabaseAddressLookup } from "../target-policy";
const INSPECTION_TIMEOUT_MS = 20_000;
export interface ProductionRecoveryTarget {
  directory: string;
  controlDatabaseUrl: string;
  lookup?: DatabaseAddressLookup;
}
/** Caller holds the exact operation's resource lock and independently rechecks recovery records before saving. */
export async function inspectProductionResourceState(
  database: typeof db,
  projectId: string,
  actorId: string,
  resourceId: string,
  revision: string,
  options: ProductionRecoveryTarget,
): Promise<"ready" | "stopped"> {
  if (!(await readProjectCapabilities(database, projectId, actorId))?.manage)
    throw new Error("Production recovery authority changed.");
  const [resource] = await database
    .select()
    .from(appDatabases)
    .where(
      and(
        eq(appDatabases.id, resourceId),
        eq(appDatabases.projectId, projectId),
        eq(appDatabases.revision, revision),
      ),
    );
  if (
    !resource ||
    resource.environment !== "production" ||
    resource.provider !== "postgres-cluster" ||
    resource.status !== "recovery_required"
  )
    throw new Error("Production recovery resource changed.");
  const binding = parseProductionResourceBinding(
    resource.id,
    resource.providerIdentity,
  );
  const [creation] = await database
    .select()
    .from(productionDatabaseProvisions)
    .where(eq(productionDatabaseProvisions.id, resource.id));
  const [server] = await database
    .select()
    .from(productionDatabaseConnections)
    .where(eq(productionDatabaseConnections.id, binding.connectionId));
  if (
    !creation ||
    creation.projectId !== projectId ||
    creation.mode !== "cluster" ||
    creation.status !== "attached" ||
    creation.connectionId !== binding.connectionId ||
    !server ||
    server.status !== "verified" ||
    server.verified?.clusterId !== binding.clusterId ||
    !server.pinnedAddresses?.length
  )
    throw new Error("Production recovery binding changed.");
  const credentials = validateProductionProjectCredentials(
    resource.id,
    JSON.parse(
      decryptDatabaseSecret(
        resource.secrets,
        await loadDatabaseKey(join(options.directory, "database-keys"), true),
        `${resource.id}:production`,
      ),
    ),
  );
  const management = openProductionConnection(
    server.secret,
    server,
    await loadDatabaseKey(
      join(options.directory, "production-instance-keys"),
      true,
    ),
  );
  const identity = {
    appClusterId: binding.clusterId,
    controlClusterId: await readControlIdentity(database),
  };
  const connection = {
    credential: management.credential,
    certificateAuthority: management.certificateAuthority,
    controlDatabaseUrl: options.controlDatabaseUrl,
    lookup: options.lookup,
    signal: AbortSignal.timeout(INSPECTION_TIMEOUT_MS),
  };
  const state = await withPinnedProductionManagement({
    ...connection,
    target: { target: server.target, addresses: server.pinnedAddresses },
    run: (client) =>
      inspectProductionProjectAvailability(
        client,
        identity,
        resource.id,
        credentials,
      ),
  });
  if (state === "ready")
    await withPinnedProductionManagement({
      ...connection,
      target: {
        target: { ...server.target, database: binding.database },
        addresses: server.pinnedAddresses,
      },
      run: async (client) => {
        await verifyProductionProjectPolicy(
          client,
          identity,
          resource.id,
          credentials,
        );
        if ((await inspectAppDatabaseSchema(client)) !== resource.schemaDigest)
          throw new Error("Production recovery schema changed.");
      },
    });
  if (!(await readProjectCapabilities(database, projectId, actorId))?.manage)
    throw new Error("Production recovery authority changed.");
  return state;
}
