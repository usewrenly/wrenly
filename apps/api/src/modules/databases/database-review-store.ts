/** Reads owner-reviewed source and verified backup choices without executing application code. */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { appDatabases, appDatabaseBackups, appDatabaseOperations, builds, type db } from "@wrenly/db";
import { DatabaseMigrationReview } from "@wrenly/db/app-database-resource-contract";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { requireProjectCapability, ProjectAccessError } from "../projects/access/project-access";
import { AccessDeniedError } from "../auth/access/access-policy";
import { lockDatabaseQueues, requireDatabaseProjectIdle } from "./database-store";
import { readDatabaseApplicationSource } from "./database-migration-review";
import { AppDatabaseError } from "./database-contract";

/** Locks authority while projecting metadata; admission independently repeats review under its own locks. */
export async function readDatabaseMigrationReview(database: typeof db, projectId: string, actorId: string,
  resourceId: string, buildId: string): Promise<DatabaseMigrationReview> {
  try {
    return await database.transaction(async tx => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      await requireDatabaseProjectIdle(tx, projectId);
      const [resource] = await tx.select().from(appDatabases).where(and(eq(appDatabases.id, resourceId), eq(appDatabases.projectId, projectId)));
      const [build] = await tx.select().from(builds).where(and(eq(builds.id, buildId), eq(builds.projectId, projectId), eq(builds.status, "success")));
      if (!resource || resource.status !== "ready" || resource.environment !== "development" || resource.provider !== "local" ||
          !build || (build.stack !== "nextjs" && build.stack !== "laravel"))
        throw new AppDatabaseError(409, "Choose a ready Development database and successful supported revision.");
      const files = readDatabaseApplicationSource(build.files);
      const manifest = readAppDatabaseManifest(files, build.stack);
      if (!manifest) throw new AppDatabaseError(409, "This revision does not declare database migrations.");
      const backups = await tx.select({ id: appDatabaseBackups.id, verifiedAt: appDatabaseBackups.verifiedAt,
        schemaDigest: appDatabaseBackups.schemaDigest }).from(appDatabaseBackups)
        .innerJoin(appDatabaseOperations, eq(appDatabaseOperations.id, appDatabaseBackups.operationId))
        .where(and(eq(appDatabaseBackups.databaseId, resourceId), eq(appDatabaseOperations.projectId, projectId),
          eq(appDatabaseOperations.kind, "backup"), eq(appDatabaseOperations.status, "success"), isNotNull(appDatabaseBackups.verifiedAt)))
        .orderBy(desc(appDatabaseBackups.verifiedAt)).limit(16);
      return DatabaseMigrationReview.parse({ projectId, resourceId, revision: resource.revision, buildId, framework: build.stack,
        migrationDigest: manifest.digest, files: manifest.files.map(file => ({ ...file,
          content: files.find(source => source.path === file.path)?.content ?? "" })), backups });
    });
  } catch (error) {
    if (error instanceof AppDatabaseError || error instanceof ProjectAccessError || error instanceof AccessDeniedError) throw error;
    throw new AppDatabaseError(503, "Saved migration review could not be verified.");
  }
}
