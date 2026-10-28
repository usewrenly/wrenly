/**
 * COMPONENT: Code/database revision compatibility
 * PURPOSE: Refuse real-data runtime binding until saved source matches applied schema history.
 * INPUTS: Current actor/project and exact saved build/resource/revision in Development.
 * OUTPUTS: Non-secret compatibility snapshot, never socket authority or credentials.
 * STEPS: Authorize, read exact ready resource/build, check latest successful migration,
 * recompute frozen source identity, refuse unresolved work, recheck access and revisions.
 * EDGE CASES: No fallback to latest source or Production; archives retain history only.
 * ERROR STATES: Mismatch requires explicit migration/reload; callers still need durable admission.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { appDatabases, appDatabaseMigrations, appDatabaseOperations, builds, projects, type db } from "@wrenly/db";
import { DatabaseBindingRequest, DatabaseRevisionBinding } from "@wrenly/db/app-database-binding-contract";
import { readProjectCapabilities } from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";
import { hasDatabaseWork } from "../database-activity";
import { readFrozenMigrationSource } from "../database-migration-review";
type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Read again under admission locks; this snapshot does not reserve or start any work. */
export async function readDatabaseRevisionBinding(
  database: Database, projectId: string, actorId: string, value: unknown,
): Promise<DatabaseRevisionBinding> {
  try {
    const parsed = DatabaseBindingRequest.safeParse(value);
    if (!parsed.success || !DatabaseRevisionBinding.shape.projectId.safeParse(projectId).success) throw new AppDatabaseError(400, "Choose an exact Development database and saved code revision.");
    const input = parsed.data;
    const access = await readProjectCapabilities(database, projectId, actorId);
    if (!access) throw new AppDatabaseError(404, "Project not found.");
    const readResource = async (): Promise<{ revision: string; schemaDigest: string | null; accessRevision: string; archivedAt: Date | null; status: string } | undefined> => {
      const [row] = await database.select({ revision: appDatabases.revision, schemaDigest: appDatabases.schemaDigest,
        accessRevision: projects.accessRevision, archivedAt: projects.archivedAt, status: appDatabases.status })
        .from(appDatabases).innerJoin(projects, eq(projects.id, appDatabases.projectId))
        .where(and(eq(appDatabases.id, input.resourceId), eq(appDatabases.projectId, projectId),
          eq(appDatabases.environment, "development"), eq(appDatabases.provider, "local"))).limit(1);
      return row;
    };
    const resource = await readResource();
    if (!resource) throw new AppDatabaseError(404, "Development database not found.");
    if (resource.archivedAt || resource.status !== "ready" || resource.revision !== input.resourceRevision || !resource.schemaDigest)
      throw new AppDatabaseError(409, "Reload the current ready database before connecting this revision.");
    if (await hasDatabaseWork(database, projectId))
      throw new AppDatabaseError(409, "Finish or reconcile database work before connecting this revision.");
    const [build] = await database.select({ files: builds.files, framework: builds.stack })
      .from(builds).where(and(eq(builds.id, input.buildId), eq(builds.projectId, projectId), eq(builds.status, "success"))).limit(1);
    if (!build || (build.framework !== "nextjs" && build.framework !== "laravel"))
      throw new AppDatabaseError(409, "Select a successful supported code revision.");
    const [migration] = await database.select({ digest: appDatabaseMigrations.digest,
      schemaDigest: appDatabaseMigrations.rehearsedSchemaDigest, operationId: appDatabaseOperations.id,
      operationDigest: appDatabaseOperations.migrationDigest, reviewedBuildId: appDatabaseMigrations.buildId, operationBuildId: appDatabaseOperations.buildId })
      .from(appDatabaseMigrations).innerJoin(appDatabaseOperations, eq(appDatabaseOperations.id, appDatabaseMigrations.operationId))
      .where(and(eq(appDatabaseMigrations.databaseId, input.resourceId), eq(appDatabaseOperations.databaseId, input.resourceId),
        eq(appDatabaseOperations.projectId, projectId), eq(appDatabaseOperations.kind, "migrate"),
        eq(appDatabaseOperations.status, "success"), isNotNull(appDatabaseMigrations.completedAt), isNotNull(appDatabaseOperations.completedAt)))
      .orderBy(desc(appDatabaseOperations.completedAt), desc(appDatabaseOperations.id)).limit(1);
    if (!migration || migration.schemaDigest !== resource.schemaDigest || migration.operationDigest !== migration.digest ||
      migration.operationBuildId !== migration.reviewedBuildId)
      throw new AppDatabaseError(409, "This database does not have a matching completed migration review.");
    try { readFrozenMigrationSource(build.files, migration.digest, build.framework); }
    catch { throw new AppDatabaseError(409, "Apply the selected revision's reviewed migrations before connecting it."); }
    const current = await readProjectCapabilities(database, projectId, actorId);
    const final = await readResource();
    if (!current || current.role !== access.role || !final || final.archivedAt || final.status !== "ready" ||
      final.accessRevision !== resource.accessRevision || final.revision !== resource.revision || final.schemaDigest !== resource.schemaDigest ||
      await hasDatabaseWork(database, projectId))
      throw new AppDatabaseError(409, "Project or database access changed. Reload before connecting this revision.");
    return DatabaseRevisionBinding.parse({ ...input, version: 1, projectId, accessRevision: resource.accessRevision,
      framework: build.framework, migrationOperationId: migration.operationId, migrationDigest: migration.digest, schemaDigest: resource.schemaDigest });
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(503, "The code and database revisions could not be verified.");
  }
}

/** Compare a previously saved binding with current authority before a runtime effect. */
export async function assertDatabaseRevisionBinding(
  database: Database, actorId: string, value: unknown,
): Promise<void> {
  try {
  const parsed = DatabaseRevisionBinding.safeParse(value);
  if (!parsed.success) throw new AppDatabaseError(409, "The saved database binding is invalid. Review this revision again.");
  const expected = parsed.data;
  const current = await readDatabaseRevisionBinding(database, expected.projectId, actorId, {
    buildId: expected.buildId, resourceId: expected.resourceId,
    resourceRevision: expected.resourceRevision, environment: expected.environment,
  });
  if (DatabaseRevisionBinding.keyof().options.some(key => current[key] !== expected[key]))
    throw new AppDatabaseError(409, "The saved code/database binding changed. Review this revision again.");
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(503, "The saved database binding could not be checked.");
  }
}
