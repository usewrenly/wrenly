/** Runtime publishing effects are saved under the same queue, account and project fences as database actions. */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  deployments,
  deploymentResources,
  appDatabases,
  productionRuntimeHosts,
  productionDatabaseConnections,
  type db,
} from "@wrenly/db";
import {
  ProductionPublishingBinding,
  validateProductionPublishingJournal,
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { accessContext } from "../../auth/access/access-context";
import { requireProductionProjectOwner } from "../../databases/production-targets/project-provisioning/store";
import { lockDatabaseQueues } from "../../databases/database-store";
import {
  DeploymentStoreError,
  type DeploymentClaim,
} from "../persistence/deployment-store";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** A saved binding is rechecked before every effect and acknowledgement, never trusted merely because admission once passed. */
export async function lockProductionPublishingRuntime(
  tx: Transaction,
  claim: DeploymentClaim,
): Promise<{
  binding: ProductionPublishingBinding;
  journal: ProductionPublishingJournal;
}> {
  z.uuid().parse(claim.deploymentId);
  z.uuid().parse(claim.token);
  await lockDatabaseQueues(tx);
  const [saved] = await tx
    .select()
    .from(deployments)
    .where(eq(deployments.id, claim.deploymentId));
  const binding = ProductionPublishingBinding.parse(
    saved?.productionDatabaseBinding,
  );
  const { accessRevision, ...principal } = binding.principal;
  await accessContext.run({ principal }, () =>
    requireProductionProjectOwner(
      tx,
      binding.projectId,
      principal,
      accessRevision,
    ),
  );
  const [row] = await tx
    .select()
    .from(deployments)
    .where(eq(deployments.id, claim.deploymentId))
    .for("update");
  if (
    !row ||
    !["preparing", "deploying", "verifying"].includes(row.status) ||
    row.claimToken !== claim.token ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt.getTime() <= Date.now() ||
    row.cancelRequestedAt ||
    row.mutationIntent ||
    row.projectId !== binding.projectId ||
    row.buildId !== binding.buildId ||
    row.userId !== binding.principal.userId ||
    row.sourceSha256 !== binding.sourceSha256 ||
    row.id !== binding.deploymentId
  )
    throw new DeploymentStoreError(
      409,
      "Production publishing no longer owns its saved execution.",
    );
  if (
    JSON.stringify(
      ProductionPublishingBinding.parse(row.productionDatabaseBinding),
    ) !== JSON.stringify(binding)
  )
    throw new DeploymentStoreError(
      409,
      "Production publishing binding changed.",
    );
  const [resource] = await tx
    .select()
    .from(appDatabases)
    .where(
      and(
        eq(appDatabases.id, binding.resourceId),
        eq(appDatabases.projectId, binding.projectId),
      ),
    )
    .for("share");
  if (
    !resource ||
    resource.environment !== "production" ||
    resource.provider !== "postgres-cluster" ||
    resource.status !== "ready" ||
    resource.revision !== binding.resourceRevision ||
    resource.schemaDigest !== binding.schemaDigest
  )
    throw new DeploymentStoreError(
      409,
      "Production database changed before publishing.",
    );
  const target = parseProductionResourceBinding(
    resource.id,
    resource.providerIdentity,
  );
  if (
    target.connectionId !== binding.connectionId ||
    target.clusterId !== binding.clusterId
  )
    throw new DeploymentStoreError(409, "Production database server changed.");
  const [connection] = await tx
    .select()
    .from(productionDatabaseConnections)
    .where(eq(productionDatabaseConnections.id, binding.connectionId));
  const [host] = await tx
    .select()
    .from(productionRuntimeHosts)
    .where(eq(productionRuntimeHosts.id, binding.hostConnectionId));
  const [placement] = await tx
    .select()
    .from(deploymentResources)
    .where(eq(deploymentResources.projectId, binding.projectId));
  if (
    connection?.status !== "verified" ||
    connection.verified?.clusterId !== binding.clusterId ||
    host?.status !== "verified" ||
    host.verified?.dockerId !== binding.dockerId ||
    host.serverId !== binding.serverId ||
    placement?.coolifyServerUuid !== binding.serverId
  )
    throw new DeploymentStoreError(
      409,
      "Verified Production placement changed.",
    );
  return {
    binding,
    journal: validateProductionPublishingJournal(
      binding,
      row.productionRuntimeJournal,
    ),
  };
}
/** Returns no credentials. Call immediately before a separately locked remote effect. */
export async function loadProductionPublishingRuntime(
  database: typeof db,
  claim: DeploymentClaim,
): Promise<{
  binding: ProductionPublishingBinding;
  journal: ProductionPublishingJournal;
}> {
  try {
    return await database.transaction((tx) =>
      lockProductionPublishingRuntime(tx, claim),
    );
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Production publishing runtime could not be verified.",
    );
  }
}
/** Saves exactly one pending effect. An unresolved remote result can never be overwritten by an ordinary retry. */
export async function beginProductionRuntimeEffect(
  database: typeof db,
  claim: DeploymentClaim,
): Promise<NonNullable<ProductionPublishingJournal["pending"]>> {
  try {
    return await database.transaction(async (tx) => {
      const { binding, journal } = await lockProductionPublishingRuntime(
        tx,
        claim,
      );
      const next = beginProductionPublishingEffect(
        binding,
        journal,
        claim.token,
        new Date(),
      );
      await tx
        .update(deployments)
        .set({ productionRuntimeJournal: next, updatedAt: new Date() })
        .where(eq(deployments.id, claim.deploymentId));
      return next.pending!;
    });
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Production publishing requires review before another runtime effect.",
    );
  }
}
/** Acknowledges only the exact current effect after rechecking the session, lease, resource and host. */
export async function acknowledgeProductionRuntimeEffect(
  database: typeof db,
  claim: DeploymentClaim,
  receipt: unknown,
): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      const { binding, journal } = await lockProductionPublishingRuntime(
        tx,
        claim,
      );
      const next = acknowledgeProductionPublishingEffect(
        binding,
        journal,
        receipt,
        claim.token,
      );
      await tx
        .update(deployments)
        .set({ productionRuntimeJournal: next, updatedAt: new Date() })
        .where(
          and(
            eq(deployments.id, claim.deploymentId),
            inArray(deployments.status, [
              "preparing",
              "deploying",
              "verifying",
            ]),
          ),
        );
    });
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Production runtime acknowledgement could not be confirmed. Inspect the saved effect before continuing.",
    );
  }
}
