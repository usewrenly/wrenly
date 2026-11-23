/** Admission freezes a ready Production resource and verified host; execution cannot choose another target later. */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  appDatabases,
  appDatabaseMigrations,
  appDatabaseOperations,
  productionDatabaseConnections,
  productionRuntimeHosts,
  projects,
  builds,
  type db,
} from "@wrenly/db";
import { ProductionPublishingBinding } from "@wrenly/db/production-publishing-contract";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { requireProductionProjectOwner } from "../../databases/production-targets/project-provisioning/store";
import {
  accessContext,
  type AccessPrincipal,
} from "../../auth/access/access-context";
import { validateDeploymentSource } from "../policy/source-policy";
import { DeploymentStoreError } from "../persistence/deployment-store";
import { assertAppliedMigrationHistory } from "../../databases/migration-history";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Internal admission only: caller already owns queue/account/project locks and persists the returned binding in that same transaction. */
export async function freezeProductionPublishingBinding(
  tx: Transaction,
  input: {
    deploymentId: string;
    projectId: string;
    buildId: string;
    sourceSha256: string;
    files: Array<{ path: string; content: string }>;
    stack: "nextjs" | "laravel";
    serverId: string;
    principal: AccessPrincipal;
  },
): Promise<ProductionPublishingBinding> {
  try {
    z.uuid().parse(input.deploymentId);
    z.uuid().parse(input.buildId);
    return await accessContext.run({ principal: input.principal }, async () => {
      await requireProductionProjectOwner(tx, input.projectId, input.principal);
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!project || project.stack !== input.stack)
        throw new Error("Project framework changed.");
      const [build] = await tx
        .select()
        .from(builds)
        .where(
          and(
            eq(builds.id, input.buildId),
            eq(builds.projectId, input.projectId),
            eq(builds.status, "success"),
          ),
        );
      if (!build || build.stack !== input.stack)
        throw new Error("Successful source revision changed.");
      const source = validateDeploymentSource(build.files),
        requestedSource = validateDeploymentSource(input.files);
      if (
        source.sha256 !== input.sourceSha256 ||
        requestedSource.sha256 !== source.sha256
      )
        throw new Error("Publishing source bytes changed.");
      const manifest = readAppDatabaseManifest(input.files, input.stack);
      if (!manifest) throw new Error("Missing saved database declaration.");
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.projectId, input.projectId),
            eq(appDatabases.environment, "production"),
          ),
        )
        .for("share");
      if (
        !resource ||
        resource.provider !== "postgres-cluster" ||
        resource.status !== "ready" ||
        !resource.schemaDigest
      )
        throw new Error("Production database is not ready.");
      const target = parseProductionResourceBinding(
        resource.id,
        resource.providerIdentity,
      );
      const [connection] = await tx
        .select()
        .from(productionDatabaseConnections)
        .where(eq(productionDatabaseConnections.id, target.connectionId));
      if (
        connection?.status !== "verified" ||
        connection.verified?.clusterId !== target.clusterId
      )
        throw new Error("Production server changed.");
      const [host] = await tx
        .select()
        .from(productionRuntimeHosts)
        .orderBy(
          desc(productionRuntimeHosts.createdAt),
          desc(productionRuntimeHosts.id),
        )
        .limit(1);
      if (
        host?.status !== "verified" ||
        !host.verified ||
        host.serverId !== input.serverId ||
        !host.pinnedAddresses?.length
      )
        throw new Error("Deployment host is not verified.");
      const [applied] = await tx
        .select({ migration: appDatabaseMigrations })
        .from(appDatabaseMigrations)
        .innerJoin(
          appDatabaseOperations,
          eq(appDatabaseOperations.id, appDatabaseMigrations.operationId),
        )
        .where(
          and(
            eq(appDatabaseMigrations.databaseId, resource.id),
            eq(appDatabaseMigrations.digest, manifest.digest),
            isNotNull(appDatabaseMigrations.completedAt),
            eq(appDatabaseOperations.projectId, input.projectId),
            eq(appDatabaseOperations.status, "success"),
          ),
        )
        .orderBy(desc(appDatabaseMigrations.completedAt))
        .limit(1);
      if (
        !applied ||
        applied.migration.rehearsedSchemaDigest !== resource.schemaDigest
      )
        throw new Error(
          "Saved migrations have not been applied to this Production schema.",
        );
      await assertAppliedMigrationHistory(
        tx,
        input.projectId,
        resource.id,
        input.files,
        input.stack,
      );
      return ProductionPublishingBinding.parse({
        version: 1,
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        buildId: input.buildId,
        sourceSha256: input.sourceSha256,
        resourceId: resource.id,
        resourceRevision: resource.revision,
        schemaDigest: resource.schemaDigest,
        migrationDigest: manifest.digest,
        connectionId: target.connectionId,
        clusterId: target.clusterId,
        hostConnectionId: host.id,
        dockerId: host.verified.dockerId,
        serverId: input.serverId,
        principal: {
          ...input.principal,
          accessRevision: project.accessRevision,
        },
      });
    });
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Review the ready Production database, applied migrations and verified deployment host before publishing this revision.",
    );
  }
}
