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
  PRODUCTION_PUBLISHING_STEPS,
} from "@wrenly/db/production-publishing-contract";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { accessContext } from "../../auth/access/access-context";
import { requireProductionProjectOwner } from "../../databases/production-targets/project-provisioning/store";
import { lockDatabaseQueues } from "../../databases/database-store";
import {
  DeploymentStoreError,
  type DeploymentClaim,
} from "../persistence/deployment-store";
// Match the existing publishing lease; verification never owns an unbounded recovery claim.
const ROUTE_RECOVERY_LEASE_MS = 30_000;
const FINAL_ROUTE_INDEX = PRODUCTION_PUBLISHING_STEPS.length - 1;
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
        .set({
          productionRuntimeJournal: next,
          updatedAt: new Date(),
          ...(next.completed.at(-1)?.fact.step === "service-start"
            ? { status: "deploying" as const }
            : {}),
          ...(next.completed.at(-1)?.fact.step === "application-start"
            ? { status: "verifying" as const }
            : {}),
        })
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
        .set({
          productionRuntimeJournal: next,
          updatedAt: new Date(),
          ...(next.completed.at(-1)?.fact.step === "service-start"
            ? { status: "deploying" as const }
            : {}),
          ...(next.completed.at(-1)?.fact.step === "application-start"
            ? { status: "verifying" as const }
            : {}),
        })
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

/** Explicit operator recovery may inspect only the final read-only route; it never resumes an unknown mutation. */
async function claimInterruptedProductionInspection(
  database: typeof db,
  deploymentId: string,
  scope: "route" | "setup",
): Promise<DeploymentClaim> {
  z.uuid().parse(deploymentId);
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const [candidate] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    const binding = ProductionPublishingBinding.parse(
      candidate?.productionDatabaseBinding,
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
      .where(eq(deployments.id, deploymentId))
      .for("update");
    if (
      !row ||
      row.status !== "interrupted" ||
      row.cancelRequestedAt ||
      row.mutationIntent ||
      (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()) ||
      JSON.stringify(row.productionDatabaseBinding) !==
        JSON.stringify(candidate?.productionDatabaseBinding)
    )
      throw new DeploymentStoreError(
        409,
        "Production route recovery requires a settled interrupted operation.",
      );
    const journal = validateProductionPublishingJournal(
      binding,
      row.productionRuntimeJournal,
    );
    const route =
      (journal.completed.length === FINAL_ROUTE_INDEX &&
        journal.pending?.step === "route-verify") ||
      (journal.completed.length === PRODUCTION_PUBLISHING_STEPS.length &&
        !journal.pending);
    const setup =
      journal.pending && SETUP_RECOVERY_STEPS.includes(journal.pending.step);
    if (scope === "route" ? !route : !setup)
      throw new DeploymentStoreError(
        409,
        scope === "route"
          ? "Inspect the earlier Production runtime effect; this command verifies routes only."
          : "The pending Production effect does not match this read-only inspector.",
      );
    const active = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        inArray(deployments.status, ["preparing", "deploying", "verifying"]),
      )
      .limit(1);
    if (active.length)
      throw new DeploymentStoreError(
        409,
        "Wait for active publishing work before route recovery.",
      );
    const token = crypto.randomUUID();
    await tx
      .update(deployments)
      .set({
        status: "verifying",
        claimToken: token,
        leaseExpiresAt: new Date(Date.now() + ROUTE_RECOVERY_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));
    const claim = { deploymentId, token };
    // Recheck every source/resource/host relationship before committing recovery ownership.
    await lockProductionPublishingRuntime(tx, claim);
    return claim;
  });
}

/** A fresh recovery claim may record the original route intent only after separate exact read-only proof. */
export async function acknowledgeRecoveredProductionRoute(
  database: typeof db,
  claim: DeploymentClaim,
  receipt: unknown,
): Promise<void> {
  await database.transaction(async (tx) => {
    const { binding, journal } = await lockProductionPublishingRuntime(
      tx,
      claim,
    );
    if (
      journal.completed.length !== FINAL_ROUTE_INDEX ||
      journal.pending?.step !== "route-verify"
    )
      throw new DeploymentStoreError(
        409,
        "Production route acknowledgement changed.",
      );
    const next = acknowledgeProductionPublishingEffect(
      binding,
      journal,
      receipt,
      journal.pending.claimToken,
    );
    await tx
      .update(deployments)
      .set({ productionRuntimeJournal: next, updatedAt: new Date() })
      .where(eq(deployments.id, claim.deploymentId));
  });
}

const SETUP_RECOVERY_STEPS: readonly string[] = [
  "http-volume",
  "database-volume",
  "broker-network",
];
/** Final route inspection retains its own narrow stage guard. */
export async function claimInterruptedProductionRoute(
  database: typeof db,
  deploymentId: string,
): Promise<DeploymentClaim> {
  return claimInterruptedProductionInspection(database, deploymentId, "route");
}
/** Setup inspection never grants permission to repeat creation or deliver runtime credentials. */
export async function claimInterruptedProductionSetup(
  database: typeof db,
  deploymentId: string,
): Promise<DeploymentClaim> {
  return claimInterruptedProductionInspection(database, deploymentId, "setup");
}
/** Record independently inspected proof for exactly the original setup intent; later work remains interrupted. */
export async function acknowledgeRecoveredProductionSetup(
  database: typeof db,
  claim: DeploymentClaim,
  receipt: unknown,
): Promise<void> {
  await database.transaction(async (tx) => {
    const { binding, journal } = await lockProductionPublishingRuntime(
      tx,
      claim,
    );
    if (
      !journal.pending ||
      !SETUP_RECOVERY_STEPS.includes(journal.pending.step)
    )
      throw new DeploymentStoreError(
        409,
        "The setup effect changed before acknowledgement.",
      );
    const next = acknowledgeProductionPublishingEffect(
      binding,
      journal,
      receipt,
      journal.pending.claimToken,
    );
    await tx
      .update(deployments)
      .set({ productionRuntimeJournal: next, updatedAt: new Date() })
      .where(eq(deployments.id, claim.deploymentId));
  });
}
