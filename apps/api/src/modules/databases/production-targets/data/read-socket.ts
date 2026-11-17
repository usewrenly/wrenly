/** Resolves a Production viewer socket internally; readers never receive management or migration credentials. */
import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import {
  appDatabases,
  appDatabaseOperations,
  productionDatabaseConnections,
  productionDatabaseProvisions,
  type db,
} from "@wrenly/db";
import {
  ProductionOperationPrincipal,
  parseProductionResourceBinding,
} from "@wrenly/db/production-resource-binding";
import { validateProductionProjectCredentials } from "@wrenly/db/production-project-credentials";
import { verifyProductionProjectPolicy } from "@wrenly/db/production-project-recovery";
import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import {
  startProductionDatabaseSocket,
  type DatabaseSocketIdentity,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import { accessContext } from "../../../auth/access/access-context";
import {
  assertDatabaseRead,
  type DatabaseReadClaim,
} from "../../viewing/view-leases";
import { heldClaim } from "../../database-store";
import { loadDatabaseKey, decryptDatabaseSecret } from "../../database-secrets";
import { openProductionConnection } from "../instance/credentials";
import { readControlIdentity } from "../setup/verification-worker";
import { withPinnedProductionManagement } from "../management-connection";
import type { DatabaseAddressLookup } from "../target-policy";

/** Requires the caller's held reader lease and resource lock; browser input cannot select an upstream or role. */
export async function openProductionDatabaseReadSocket(input: {
  database: typeof db;
  directory: string;
  claim: DatabaseReadClaim;
  controlDatabaseUrl: string;
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<{
  socket: DatabaseSocketIdentity;
  role: { user: string; password: string };
}> {
  const { database, claim } = input;
  await input.fence.assertHeld();
  await assertDatabaseRead(database, claim);
  const [operation] = await database
    .select()
    .from(appDatabaseOperations)
    .where(heldClaim(claim));
  const principal = ProductionOperationPrincipal.parse(
    operation?.executionPrincipal,
  );
  const current = accessContext.getStore()?.principal;
  if (
    !current ||
    principal.userId !== claim.actorId ||
    current.userId !== principal.userId ||
    current.sessionId !== principal.sessionId ||
    current.revision !== principal.revision ||
    principal.accessRevision !== claim.authority.accessRevision
  )
    throw new Error("Production reader session changed.");
  const [resource] = await database
    .select()
    .from(appDatabases)
    .where(
      and(
        eq(appDatabases.id, claim.resourceId),
        eq(appDatabases.projectId, claim.projectId),
        eq(appDatabases.revision, claim.request.revision),
      ),
    );
  if (
    !resource ||
    resource.provider !== "postgres-cluster" ||
    resource.environment !== "production" ||
    resource.status !== "ready"
  )
    throw new Error("Production reader resource changed.");
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
    creation.mode !== "cluster" ||
    creation.projectId !== claim.projectId ||
    creation.status !== "attached" ||
    creation.connectionId !== binding.connectionId ||
    !server ||
    server.status !== "verified" ||
    server.verified?.clusterId !== binding.clusterId ||
    !server.pinnedAddresses?.length
  )
    throw new Error("Production reader target changed.");
  const key = await loadDatabaseKey(
    join(input.directory, "database-keys"),
    true,
  );
  const credentials = validateProductionProjectCredentials(
    resource.id,
    JSON.parse(
      decryptDatabaseSecret(resource.secrets, key, `${resource.id}:production`),
    ),
  );
  if (credentials.database !== binding.database)
    throw new Error("Production reader database changed.");
  const management = openProductionConnection(
    server.secret,
    server,
    await loadDatabaseKey(
      join(input.directory, "production-instance-keys"),
      true,
    ),
  );
  const controlClusterId = await readControlIdentity(database);
  const address = server.pinnedAddresses[0];
  if (!address) throw new Error("Production reader destination unavailable.");
  const socket = await startProductionDatabaseSocket({
    scope: {
      resourceId: resource.id,
      projectId: claim.projectId,
      environment: "production",
    },
    socketId: claim.id,
    networkId: binding.networkId,
    upstream: {
      hostname: server.target.host,
      address,
      port: server.target.port,
    },
    credentials,
    role: "reader",
    certificateAuthority: management.certificateAuthority,
    fence: input.fence,
    signal: input.signal,
    verifyTarget: async () => {
      await input.fence.assertHeld();
      await assertDatabaseRead(database, claim);
      await withPinnedProductionManagement({
        target: {
          target: { ...server.target, database: binding.database },
          addresses: server.pinnedAddresses!,
        },
        ...management,
        controlDatabaseUrl: input.controlDatabaseUrl,
        signal: input.signal,
        lookup: input.lookup,
        run: async (connection) => {
          await verifyProductionProjectPolicy(
            connection,
            { appClusterId: binding.clusterId, controlClusterId },
            resource.id,
            credentials,
          );
          if (
            (await inspectAppDatabaseSchema(connection)) !==
            resource.schemaDigest
          )
            throw new Error("Production reader schema changed.");
        },
      });
    },
  });
  await assertDatabaseRead(database, claim);
  return { socket, role: credentials.reader };
}
