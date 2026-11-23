/** Explicit owner actions on a ready Production resource, with exact replay and a fresh saved session identity. */
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  appDatabases,
  appDatabaseOperations,
  projects,
  appDatabaseMigrations,
  type db,
} from "@wrenly/db";
import {
  DatabaseAction,
  type DatabaseActionAcknowledgement,
} from "@wrenly/db/app-database-action-contract";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { requireProductionProjectOwner } from "../project-provisioning/store";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  hasDatabaseWork,
} from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import { prepareDatabaseMigrationReview } from "../../database-migration-review";
const MAX_PENDING_ACTIONS = 8;
/** Importing/admitting starts no worker. Only implemented actions may enter this provider queue. */
export async function admitProductionDatabaseAction(
  database: typeof db,
  principal: AccessPrincipal,
  projectId: string,
  raw: unknown,
): Promise<DatabaseActionAcknowledgement> {
  z.uuid().parse(projectId);
  const action = DatabaseAction.parse(raw);
  if (
    action.environment !== "production" ||
    !["backup", "migrate", "start", "stop"].includes(action.kind)
  )
    throw new AppDatabaseError(
      409,
      "This Production action is not available yet.",
    );
  const identity = createHash("sha256")
    .update(JSON.stringify([projectId, principal.userId, action]))
    .digest("hex");
  return accessContext.run({ principal }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProductionProjectOwner(tx, projectId, principal);
      const [replay] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.actorId, principal.userId),
            eq(appDatabaseOperations.requestId, action.requestId),
          ),
        );
      if (replay) {
        if (
          replay.projectId !== projectId ||
          replay.requestIdentity !== identity
        )
          throw new AppDatabaseError(
            409,
            "This request already represents a different database action.",
          );
        return {
          operationId: replay.id,
          resourceId: replay.databaseId,
          replayed: true,
        };
      }
      await requireDatabaseProjectIdle(tx, projectId);
      if (await hasDatabaseWork(tx, projectId))
        throw new AppDatabaseError(
          409,
          "Finish or inspect existing database work first.",
        );
      const pending = await tx
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(
          inArray(appDatabaseOperations.status, [
            "queued",
            "running",
            "interrupted",
          ]),
        )
        .limit(MAX_PENDING_ACTIONS);
      if (pending.length >= MAX_PENDING_ACTIONS)
        throw new AppDatabaseError(
          429,
          "Database work is busy. Try again shortly.",
        );
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.projectId, projectId),
            eq(appDatabases.environment, "production"),
          ),
        )
        .for("update");
      if (
        !resource ||
        resource.provider !== "postgres-cluster" ||
        resource.status !== (action.kind === "start" ? "stopped" : "ready") ||
        resource.revision !== action.expectedRevision
      )
        throw new AppDatabaseError(
          409,
          "Reload the current ready Production database before confirming this action.",
        );
      parseProductionResourceBinding(resource.id, resource.providerIdentity);
      const [project] = await tx
        .select({ revision: projects.accessRevision })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) throw new AppDatabaseError(404, "Project not found.");
      const migrationReview =
        action.kind === "migrate" &&
        action.buildId &&
        action.backupId &&
        action.migrationDigest
          ? await prepareDatabaseMigrationReview(tx, {
              projectId,
              resourceId: resource.id,
              buildId: action.buildId,
              backupId: action.backupId,
              migrationDigest: action.migrationDigest,
            })
          : undefined;
      const id = crypto.randomUUID();
      await tx.insert(appDatabaseOperations).values({
        id,
        databaseId: resource.id,
        projectId,
        actorId: principal.userId,
        executionPrincipal: {
          ...principal,
          accessRevision: project.revision,
        },
        requestId: action.requestId,
        requestIdentity: identity,
        kind: action.kind,
        expectedRevision: resource.revision,
        buildId: action.buildId,
        migrationDigest: action.migrationDigest,
      });
      if (migrationReview && action.buildId && action.migrationDigest)
        await tx.insert(appDatabaseMigrations).values({
          databaseId: resource.id,
          operationId: id,
          buildId: action.buildId,
          digest: action.migrationDigest,
          ...migrationReview,
        });
      return { operationId: id, resourceId: resource.id, replayed: false };
    }),
  );
}
