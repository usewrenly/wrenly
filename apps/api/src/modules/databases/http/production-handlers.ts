/** Composes authenticated database handlers explicitly; importing this file starts no worker or listener. */
import { admitProductionResourceCommand } from "../production-targets/data/http";
import type { db } from "@wrenly/db";
import type { ApiHandlers } from "../../../app";
import { createDatabaseResourceStatusHandler } from "./resource-status";
import { createDatabaseActionHandlers } from "./actions";
import { createDatabaseRecoveryHandlers } from "./recovery";
import { createDatabaseMigrationReviewHandler } from "./migration-review";
import { createDatabaseRecoveryReviewHandler } from "./recovery-review";
import { readDatabaseActionAcknowledgement } from "./action-acknowledgement-store";
import { admitDatabaseAction, readDatabaseResources } from "../database-store";
import { admitDatabaseRecovery } from "../database-recovery-admission";
import { readDatabaseMigrationReview } from "../database-review-store";
import { readDatabaseRecoveryReview } from "../database-recovery-review";
import { createDatabaseViewHandler } from "../viewing/view-http";
import { readDatabaseViewAuthority } from "../viewing/view-authority";
import { runDatabaseViewQuery } from "../viewing/view-runtime";

/** The caller must verify host/toolchains and own worker shutdown before installing these routes. */
export function createProductionDatabaseHandlers(
  database: typeof db,
  options: {
    productionReader?: { controlDatabaseUrl: string };
    productionManagement?: boolean;
    directory: string;
    webUrl: string;
    userId: (headers: Headers) => Promise<string | null>;
  },
): NonNullable<ApiHandlers["projectDatabases"]> {
  const userId = options.userId;
  const lookup = (
    project: string,
    actor: string,
    requestId: string,
  ): ReturnType<typeof readDatabaseActionAcknowledgement> =>
    readDatabaseActionAcknowledgement(database, project, actor, requestId);
  return {
    status: createDatabaseResourceStatusHandler({
      userId,
      read: async (project, actor) => {
        const status = await readDatabaseResources(database, project, actor);
        return {
          ...status,
          capabilities: {
            ...status.capabilities,
            productionManagement: options.productionManagement === true,
          },
        };
      },
    }),
    actions: createDatabaseActionHandlers(
      {
        userId,
        lookup,
        admit: (project, actor, action) =>
          action.environment === "production"
            ? options.productionManagement && options.productionReader
              ? admitProductionResourceCommand(database, project, actor, action)
              : Promise.reject(
                  new Error("Production management is not enabled."),
                )
            : admitDatabaseAction(
                database,
                project,
                actor,
                action,
                options.directory,
              ),
      },
      options.webUrl,
    ),
    recovery: createDatabaseRecoveryHandlers(
      {
        userId,
        lookup,
        admit: (project, actor, action) =>
          admitDatabaseRecovery(
            database,
            project,
            actor,
            action,
            options.directory,
            options.productionManagement && options.productionReader
              ? { ...options.productionReader, directory: options.directory }
              : undefined,
          ),
      },
      options.webUrl,
    ),
    migrationReview: createDatabaseMigrationReviewHandler({
      userId,
      read: (project, actor, resource, build) =>
        readDatabaseMigrationReview(database, project, actor, resource, build),
    }),
    recoveryReview: createDatabaseRecoveryReviewHandler({
      userId,
      read: (project, actor, resource, operation) =>
        readDatabaseRecoveryReview(
          database,
          project,
          actor,
          resource,
          operation,
        ),
    }),
    view: createDatabaseViewHandler({
      userId,
      authority: (project, actor, selection) =>
        readDatabaseViewAuthority(database, project, actor, selection),
      query: (project, actor, selection, signal) =>
        runDatabaseViewQuery(
          database,
          options.directory,
          project,
          actor,
          selection,
          signal,
          options.productionReader,
        ),
    }),
  };
}
