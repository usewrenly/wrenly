/** Transfers completed SQL creation into the ordinary resource journal; SQL-created is never silently marked ready. */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";
import {
  appDatabases,
  appDatabaseOperations,
  productionDatabaseProvisions as provisions,
  productionDatabaseConnections as connections,
  type db,
} from "@wrenly/db";
import {
  validateProductionProjectCredentials,
  PRODUCTION_PROVISION_PHASES,
} from "@wrenly/db/production-project-credentials";
import {
  ProductionOperationPrincipal,
  PendingProductionResourceBinding,
} from "@wrenly/db/production-resource-binding";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { AppDatabaseError } from "../../database-contract";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  heldClaim,
  type DatabaseClaim,
} from "../../database-store";
import {
  encryptDatabaseSecret,
  decryptDatabaseSecret,
  loadDatabaseKey,
} from "../../database-secrets";
import { openProductionConnection } from "../instance/credentials";
import {
  requireProductionProjectOwner,
  loadProductionProjectKey,
  productionProjectSecretPurpose,
} from "./store";
type Connection = typeof db;
export interface ProductionResourceReceipt {
  resourceId: string;
  operationId: string;
  replayed: boolean;
}
/** Internal handoff after completed SQL; one transaction preserves both journals and creates no network/runtime effects. */
export async function attachProductionProjectResource(input: {
  database: Connection;
  principal: AccessPrincipal;
  projectId: string;
  provisionId: string;
  directory: string;
}): Promise<ProductionResourceReceipt> {
  z.uuid().parse(input.projectId);
  z.uuid().parse(input.provisionId);
  return accessContext.run({ principal: input.principal }, async () => {
    await input.database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProductionProjectOwner(tx, input.projectId, input.principal);
    });
    const projectKey = await loadProductionProjectKey(
      input.database,
      input.directory,
    );
    const [existing] = await input.database
      .select({ id: appDatabases.id })
      .from(appDatabases)
      .limit(1);
    const key = await loadDatabaseKey(
      join(input.directory, "database-keys"),
      Boolean(existing),
    );
    return input.database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [saved] = await tx
        .select()
        .from(provisions)
        .where(
          and(
            eq(provisions.id, input.provisionId),
            eq(provisions.projectId, input.projectId),
          ),
        )
        .for("update");
      if (
        !saved ||
        saved.mode !== "cluster" ||
        saved.actorId !== input.principal.userId
      )
        throw new AppDatabaseError(404, "Production creation not found.");
      await requireProductionProjectOwner(
        tx,
        input.projectId,
        input.principal,
        saved.accessRevision,
      );
      if (saved.status === "attached") {
        const [operation] = await tx
          .select({ id: appDatabaseOperations.id })
          .from(appDatabaseOperations)
          .where(
            and(
              eq(appDatabaseOperations.databaseId, saved.id),
              eq(appDatabaseOperations.kind, "create"),
            ),
          )
          .limit(1);
        if (!operation)
          throw new AppDatabaseError(
            409,
            "Production creation handoff needs inspection.",
          );
        return {
          resourceId: saved.id,
          operationId: operation.id,
          replayed: true,
        };
      }
      if (
        saved.status !== "created" ||
        saved.effectPhase ||
        saved.effectStartedAt ||
        !saved.acknowledgedAt ||
        JSON.stringify(saved.completedPhases) !==
          JSON.stringify(PRODUCTION_PROVISION_PHASES)
      )
        throw new AppDatabaseError(
          409,
          "Finish and confirm every Production SQL setup step first.",
        );
      await requireDatabaseProjectIdle(tx, input.projectId);
      const busy = await tx
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.projectId, input.projectId),
            inArray(appDatabaseOperations.status, [
              "queued",
              "running",
              "interrupted",
            ]),
          ),
        )
        .limit(1);
      if (busy.length)
        throw new AppDatabaseError(
          409,
          "Finish or inspect existing database work first.",
        );
      const [server] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, saved.connectionId!));
      if (
        !server ||
        server.status !== "verified" ||
        !server.verified ||
        !server.pinnedAddresses?.length
      )
        throw new AppDatabaseError(
          409,
          "Saved Production connection is unavailable.",
        );
      const credentials = validateProductionProjectCredentials(
        saved.id,
        JSON.parse(
          decryptDatabaseSecret(
            saved.secrets,
            projectKey,
            productionProjectSecretPurpose(saved),
          ),
        ),
      );
      const binding = PendingProductionResourceBinding.parse({
        version: "1",
        provider: "postgres-cluster",
        connectionId: server.id,
        clusterId: server.verified.clusterId,
        database: credentials.database,
      });
      const id = crypto.randomUUID();
      await tx.insert(appDatabases).values({
        id: saved.id,
        projectId: saved.projectId,
        environment: "production",
        provider: "postgres-cluster",
        status: "provisioning",
        providerIdentity: binding,
        createdBy: saved.actorId,
        secrets: encryptDatabaseSecret(
          JSON.stringify(credentials),
          key,
          `${saved.id}:production`,
        ),
      });
      await tx.insert(appDatabaseOperations).values({
        id,
        databaseId: saved.id,
        projectId: saved.projectId,
        actorId: saved.actorId,
        executionPrincipal: {
          ...input.principal,
          accessRevision: saved.accessRevision,
        },
        requestId: saved.requestId,
        requestIdentity: saved.requestIdentity,
        kind: "create",
      });
      await tx
        .update(provisions)
        .set({ status: "attached", executionPrincipal: input.principal })
        .where(eq(provisions.id, saved.id));
      return { resourceId: saved.id, operationId: id, replayed: false };
    });
  });
}
/** Loads only a currently claimed Production resource and its original immutable server connection. */
export async function loadProductionResourceExecution(
  database: Connection,
  claim: DatabaseClaim,
  directory: string,
): Promise<{
  principal: AccessPrincipal;
  resource: typeof appDatabases.$inferSelect;
  operation: typeof appDatabaseOperations.$inferSelect;
  credentials: ReturnType<typeof validateProductionProjectCredentials>;
  server: {
    target: typeof connections.$inferSelect.target;
    addresses: string[];
    clusterId: string;
    credential: { user: string; password: string };
    certificateAuthority?: string;
  };
}> {
  const key = await loadDatabaseKey(join(directory, "database-keys"), true);
  const instanceKey = await loadDatabaseKey(
    join(directory, "production-instance-keys"),
    true,
  );
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const [operation] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(heldClaim(claim));
    if (
      !operation?.leaseExpiresAt ||
      operation.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new AppDatabaseError(409, "Production resource claim expired.");
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, claim.resourceId),
          eq(appDatabases.projectId, claim.projectId),
        ),
      );
    const [creation] = await tx
      .select()
      .from(provisions)
      .where(eq(provisions.id, claim.resourceId));
    if (
      !resource ||
      resource.provider !== "postgres-cluster" ||
      resource.environment !== "production" ||
      !creation ||
      creation.mode !== "cluster" ||
      creation.status !== "attached" ||
      creation.actorId !== operation.actorId
    )
      throw new AppDatabaseError(409, "Production resource identity changed.");
    const parsedPrincipal = ProductionOperationPrincipal.safeParse(
      operation.executionPrincipal,
    );
    const principal = parsedPrincipal.success ? parsedPrincipal.data : null;
    if (!principal || principal.userId !== operation.actorId)
      throw new AppDatabaseError(
        409,
        "Production operation has no saved session authority.",
      );
    await accessContext.run({ principal }, () =>
      requireProductionProjectOwner(
        tx,
        claim.projectId,
        principal,
        principal.accessRevision,
      ),
    );
    const { networkId: _networkId, ...pending } =
      resource.providerIdentity ?? {};
    const binding = PendingProductionResourceBinding.parse(pending);
    const [server] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, binding.connectionId));
    if (
      !server ||
      server.status !== "verified" ||
      server.verified?.clusterId !== binding.clusterId ||
      !server.pinnedAddresses?.length ||
      creation.connectionId !== server.id
    )
      throw new AppDatabaseError(
        409,
        "Production server verification changed.",
      );
    const credentials = validateProductionProjectCredentials(
      resource.id,
      JSON.parse(
        decryptDatabaseSecret(
          resource.secrets,
          key,
          `${resource.id}:production`,
        ),
      ),
    );
    if (credentials.database !== binding.database)
      throw new AppDatabaseError(409, "Production project database changed.");
    return {
      principal,
      resource,
      operation,
      credentials,
      server: {
        target: server.target,
        addresses: server.pinnedAddresses,
        clusterId: binding.clusterId,
        ...openProductionConnection(server.secret, server, instanceKey),
      },
    };
  });
}
/** Saves the exact newly created broker network only while its original create effect is active. */
export async function saveProductionResourceNetwork(
  database: Connection,
  claim: DatabaseClaim,
  networkId: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(networkId))
    throw new Error("Invalid Production broker network.");
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const [operation] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(and(heldClaim(claim), isNull(appDatabaseOperations.cleanupEffect)))
      .for("update");
    if (
      !operation?.leaseExpiresAt ||
      operation.leaseExpiresAt.getTime() <= Date.now() ||
      operation.kind !== "create" ||
      operation.effect?.kind !== "create-network"
    )
      throw new AppDatabaseError(409, "Production network effect changed.");
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(eq(appDatabases.id, claim.resourceId))
      .for("update");
    if (
      !resource ||
      resource.projectId !== claim.projectId ||
      resource.environment !== "production" ||
      resource.provider !== "postgres-cluster" ||
      resource.status !== "provisioning"
    )
      throw new AppDatabaseError(409, "Production resource changed.");
    const binding = PendingProductionResourceBinding.parse(
      resource.providerIdentity,
    );
    await tx
      .update(appDatabases)
      .set({
        providerIdentity: { ...binding, networkId },
        updatedAt: new Date(),
      })
      .where(eq(appDatabases.id, resource.id));
  });
}

/** Readiness metadata follows a verified role policy and a completed reader query, with every helper closed. */
export async function saveProductionResourceSchema(
  database: Connection,
  claim: DatabaseClaim,
  schemaDigest: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(schemaDigest))
    throw new Error("Invalid Production schema digest.");
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const [operation] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          heldClaim(claim),
          isNull(appDatabaseOperations.effect),
          isNull(appDatabaseOperations.cleanupEffect),
        ),
      )
      .for("update");
    if (
      !operation?.leaseExpiresAt ||
      operation.leaseExpiresAt.getTime() <= Date.now() ||
      operation.kind !== "create" ||
      !operation.completedEffects.some(
        (effect) => effect.kind === "provision-roles",
      ) ||
      !operation.completedEffects.some(
        (effect) => effect.kind === "read-database",
      ) ||
      !operation.completedCleanupEffects.some(
        (effect) => effect.kind === "close-reader-socket",
      )
    )
      throw new AppDatabaseError(
        409,
        "Production readiness effects are not settled.",
      );
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, claim.resourceId),
          eq(appDatabases.projectId, claim.projectId),
        ),
      )
      .for("update");
    if (
      !resource ||
      resource.provider !== "postgres-cluster" ||
      resource.environment !== "production" ||
      resource.status !== "provisioning"
    )
      throw new AppDatabaseError(
        409,
        "Production resource changed during verification.",
      );
    await tx
      .update(appDatabases)
      .set({ schemaDigest, updatedAt: new Date() })
      .where(eq(appDatabases.id, resource.id));
  });
}
