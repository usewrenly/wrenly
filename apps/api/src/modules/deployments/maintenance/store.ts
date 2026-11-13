/** Owner-confirmed maintenance permissions; no remote process or credential is loaded here. */
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type db,
  user,
  projects,
  deployments,
  appDatabases,
  deploymentResources,
  productionDatabaseConnections,
  productionRuntimeHosts,
  productionRuntimeMaintenance,
  productionRuntimeMaintenanceActions,
} from "@wrenly/db";
import {
  ProductionMaintenanceGrant,
  assessProductionMaintenance,
} from "@wrenly/db/production-maintenance-contract";
import {
  ProductionPublishingBinding,
  validateProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { readActivePrincipal } from "../../auth/access/access-policy";
import type { AccessPrincipal } from "../../auth/access/access-context";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  hasDatabaseWork,
} from "../../databases/database-store";
import { DeploymentStoreError } from "../persistence/deployment-store";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const Decision = z
  .object({
    requestId: z.uuid(),
    expectedAccessRevision: z.uuid(),
    expectedGrantRevision: z.uuid().nullable(),
    state: z.enum(["enabled", "paused", "revoked"]),
    confirmMaintenance: z.literal(true),
  })
  .strict();
export interface MaintenancePermissionReceipt {
  grant: ProductionMaintenanceGrant;
  replayed: boolean;
}

/** Queue locks precede account/project locks; ownership and the live session are checked even for withdrawal. */
async function lockOwner(
  tx: Transaction,
  projectId: string,
  actor: AccessPrincipal,
): Promise<typeof projects.$inferSelect> {
  await lockDatabaseQueues(tx);
  const [account] = await tx
    .select()
    .from(user)
    .where(eq(user.id, actor.userId))
    .for("share");
  const current = await readActivePrincipal(tx, actor.userId, actor.sessionId);
  if (!account || account.banned || current?.revision !== actor.revision)
    throw new DeploymentStoreError(
      404,
      "Sign in again before changing maintenance permission.",
    );
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
  if (!project || project.userId !== actor.userId)
    throw new DeploymentStoreError(
      404,
      "Only the project owner can change maintenance permission.",
    );
  return project;
}

/** A grant is created only from locked server records, never binding/evidence supplied by a browser. */
export async function verifyMaintenancePublication(
  tx: Transaction,
  grant: ProductionMaintenanceGrant,
): Promise<void> {
  const b = grant.binding;
  await requireDatabaseProjectIdle(tx, b.projectId);
  if (await hasDatabaseWork(tx, b.projectId))
    throw new DeploymentStoreError(
      409,
      "Finish or recover database work before enabling maintenance.",
    );
  const [publication] = await tx
    .select()
    .from(deployments)
    .where(eq(deployments.id, b.deploymentId))
    .for("share");
  const [resource] = await tx
    .select()
    .from(appDatabases)
    .where(eq(appDatabases.id, b.resourceId))
    .for("share");
  const [host] = await tx
    .select()
    .from(productionRuntimeHosts)
    .where(eq(productionRuntimeHosts.id, b.hostConnectionId))
    .for("share");
  const [connection] = await tx
    .select()
    .from(productionDatabaseConnections)
    .where(eq(productionDatabaseConnections.id, b.connectionId))
    .for("share");
  const [placement] = await tx
    .select()
    .from(deploymentResources)
    .where(eq(deploymentResources.projectId, b.projectId))
    .for("share");
  if (
    !publication ||
    !resource ||
    resource.projectId !== b.projectId ||
    resource.environment !== "production" ||
    resource.provider !== "postgres-cluster" ||
    !host ||
    !connection ||
    !placement ||
    publication.mutationIntent ||
    publication.cancelRequestedAt ||
    publication.buildId !== b.buildId ||
    publication.sourceSha256 !== b.sourceSha256 ||
    publication.userId !== grant.confirmedBy.userId
  )
    throw new DeploymentStoreError(
      409,
      "The reviewed publication is unavailable or changed.",
    );
  const [currentPublication] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.projectId, b.projectId),
        eq(deployments.status, "success"),
      ),
    )
    .orderBy(
      desc(deployments.completedAt),
      desc(deployments.createdAt),
      desc(deployments.id),
    )
    .limit(1);
  if (currentPublication?.id !== b.deploymentId)
    throw new DeploymentStoreError(
      409,
      "A newer successful publication needs its own maintenance permission.",
    );
  const target = parseProductionResourceBinding(
    resource.id,
    resource.providerIdentity,
  );
  const decision = assessProductionMaintenance(grant, {
    grantRevision: grant.revision,
    ownerId: grant.confirmedBy.userId,
    ownerRevision: grant.confirmedBy.revision,
    ownerActive: true,
    projectAccessRevision: b.principal.accessRevision,
    projectArchived: false,
    resourceRevision: resource.revision,
    resourceReady: resource.status === "ready",
    schemaDigest: resource.schemaDigest,
    connectionId: target.connectionId,
    clusterId: target.clusterId,
    hostConnectionId: host.id,
    hostVerified:
      host.status === "verified" &&
      connection.status === "verified" &&
      connection.verified?.clusterId === b.clusterId &&
      placement.coolifyServerUuid === b.serverId,
    dockerId: host.verified?.dockerId,
    serverId: host.serverId,
    conflictingWork: false,
    publicationStatus: publication.status,
    binding: publication.productionDatabaseBinding,
    publication: publication.productionRuntimeJournal,
  });
  if (!decision.allowed)
    throw new DeploymentStoreError(
      409,
      "Review the current publication and infrastructure before enabling maintenance.",
    );
}

/** Atomically save permission plus exact action replay; pause/revoke never depend on a reachable deployment host. */
export async function changeMaintenancePermission(
  database: typeof db,
  actor: AccessPrincipal,
  projectId: string,
  deploymentId: string,
  raw: unknown,
): Promise<MaintenancePermissionReceipt> {
  z.uuid().parse(projectId);
  z.uuid().parse(deploymentId);
  const input = Decision.parse(raw);
  const identity = createHash("sha256")
    .update(JSON.stringify([projectId, deploymentId, input]))
    .digest("hex");
  try {
    return await database.transaction(async (tx) => {
      const project = await lockOwner(tx, projectId, actor);
      const [replay] = await tx
        .select()
        .from(productionRuntimeMaintenanceActions)
        .where(
          and(
            eq(productionRuntimeMaintenanceActions.actorId, actor.userId),
            eq(productionRuntimeMaintenanceActions.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (
          replay.requestIdentity !== identity ||
          replay.projectId !== projectId ||
          replay.deploymentId !== deploymentId
        )
          throw new DeploymentStoreError(
            409,
            "This maintenance request contains different reviewed values.",
          );
        return {
          grant: ProductionMaintenanceGrant.parse(replay.result),
          replayed: true,
        };
      }
      const [saved] = await tx
        .select()
        .from(productionRuntimeMaintenance)
        .where(eq(productionRuntimeMaintenance.deploymentId, deploymentId))
        .for("update");
      const previous = saved
        ? ProductionMaintenanceGrant.parse(saved.grant)
        : null;
      if (
        project.accessRevision !== input.expectedAccessRevision ||
        (previous?.revision ?? null) !== input.expectedGrantRevision ||
        (saved && saved.projectId !== projectId)
      )
        throw new DeploymentStoreError(
          409,
          "Maintenance permission changed. Reload and review it again.",
        );
      if (previous?.state === "revoked")
        throw new DeploymentStoreError(
          409,
          "Revoked permission cannot be resumed. Publish and review a new version.",
        );
      if (!previous && input.state !== "enabled")
        throw new DeploymentStoreError(
          409,
          "No maintenance permission exists for this publication.",
        );
      const [publication] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));
      if (!publication || publication.projectId !== projectId)
        throw new DeploymentStoreError(404, "Publication not found.");
      const binding =
        previous?.binding ??
        ProductionPublishingBinding.parse(
          publication.productionDatabaseBinding,
        );
      if (
        binding.projectId !== projectId ||
        binding.deploymentId !== deploymentId
      )
        throw new DeploymentStoreError(409, "Publication identity changed.");
      const now = new Date();
      const grant = ProductionMaintenanceGrant.parse({
        version: 1,
        id: previous?.id ?? crypto.randomUUID(),
        revision: crypto.randomUUID(),
        requestId: input.requestId,
        state: input.state,
        confirmedAt:
          input.state === "enabled" ? now.toISOString() : previous!.confirmedAt,
        confirmedBy:
          input.state === "enabled"
            ? { ...actor, accessRevision: project.accessRevision }
            : previous!.confirmedBy,
        confirmMaintenance: true,
        binding,
        publication:
          previous?.publication ??
          validateProductionPublishingJournal(
            binding,
            publication.productionRuntimeJournal,
          ),
      });
      if (input.state === "enabled") {
        if (project.archivedAt)
          throw new DeploymentStoreError(
            409,
            "Archived projects cannot enable maintenance.",
          );
        await verifyMaintenancePublication(tx, grant);
      }
      await tx
        .insert(productionRuntimeMaintenance)
        .values({ deploymentId, projectId, grant, updatedAt: now })
        .onConflictDoUpdate({
          target: productionRuntimeMaintenance.deploymentId,
          set: { grant, updatedAt: now },
        });
      await tx.insert(productionRuntimeMaintenanceActions).values({
        id: crypto.randomUUID(),
        deploymentId,
        projectId,
        actorId: actor.userId,
        sessionId: actor.sessionId,
        accountRevision: actor.revision,
        requestId: input.requestId,
        requestIdentity: identity,
        result: grant,
      });
      return { grant, replayed: false };
    });
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Maintenance permission could not be confirmed. Reload its saved state before trying again.",
    );
  }
}

/** Background authority comes from the separately confirmed grant, never a synthetic or expired browser session. */
export async function loadMaintenanceAuthority(
  database: typeof db,
  deploymentId: string,
  expectedRevision: string,
): Promise<ProductionMaintenanceGrant> {
  z.uuid().parse(deploymentId);
  z.uuid().parse(expectedRevision);
  try {
    return await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [snapshot] = await tx
        .select()
        .from(productionRuntimeMaintenance)
        .where(eq(productionRuntimeMaintenance.deploymentId, deploymentId));
      const grant = ProductionMaintenanceGrant.parse(snapshot?.grant);
      const [account] = await tx
        .select()
        .from(user)
        .where(eq(user.id, grant.confirmedBy.userId))
        .for("share");
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, grant.binding.projectId))
        .for("share");
      const [saved] = await tx
        .select()
        .from(productionRuntimeMaintenance)
        .where(eq(productionRuntimeMaintenance.deploymentId, deploymentId))
        .for("share");
      if (
        !account ||
        account.banned ||
        account.accessRevision !== grant.confirmedBy.revision ||
        !project ||
        project.userId !== account.id ||
        project.archivedAt ||
        project.accessRevision !== grant.binding.principal.accessRevision ||
        snapshot?.projectId !== project.id ||
        grant.binding.deploymentId !== deploymentId ||
        grant.state !== "enabled" ||
        grant.revision !== expectedRevision ||
        JSON.stringify(ProductionMaintenanceGrant.parse(saved?.grant)) !==
          JSON.stringify(grant)
      )
        throw new DeploymentStoreError(
          409,
          "Maintenance permission is inactive or its owner/project changed.",
        );
      await verifyMaintenancePublication(tx, grant);
      return grant;
    });
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Current maintenance authority could not be verified.",
    );
  }
}
