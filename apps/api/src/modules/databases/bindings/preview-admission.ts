/** A Prepare click may use only the database saved with the selected build; current evidence is rechecked by admission. */
import { and, eq } from "drizzle-orm";
import { builds, buildJobs, appDatabases, type db } from "@wrenly/db";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { readProjectCapabilities } from "../../projects/access/project-access";
import { admitPreview, admitDatabasePreview, PreviewStoreError } from "../../previews/persistence/preview-store";

/** Migrations may advance the same resource's revision; never substitute another resource or infer from model text. */
export async function admitSelectedBuildPreview(database: typeof db, buildId: string, actorId: string, key: string,
  enabled: boolean): Promise<{ previewId: string; replayed: boolean }> {
  try {
    const [saved] = await database.select({ projectId: builds.projectId, input: buildJobs.input }).from(builds)
      .leftJoin(buildJobs, eq(buildJobs.buildId, builds.id)).where(eq(builds.id, buildId));
    if (!saved || !await readProjectCapabilities(database, saved.projectId, actorId)) throw new PreviewStoreError(404, "Build not found.");
    if (saved.input?.databaseV1 === undefined) return await admitPreview(database, buildId, actorId, key);
    if (!enabled) throw new PreviewStoreError(409, "Development database previews are not enabled on this instance.");
    const selection = BuildDatabaseSelection.safeParse(saved.input.databaseV1);
    if (!selection.success) throw new PreviewStoreError(409, "The saved database selection could not be verified.");
    const [resource] = await database.select({ revision: appDatabases.revision }).from(appDatabases).where(and(
      eq(appDatabases.id, selection.data.resourceId), eq(appDatabases.projectId, saved.projectId),
      eq(appDatabases.environment, "development"), eq(appDatabases.provider, "local"), eq(appDatabases.status, "ready")));
    if (!resource) throw new PreviewStoreError(409, "Review this build’s Development database before preparing its preview.");
    return await admitDatabasePreview(database, buildId, actorId, key, { ...selection.data, resourceRevision: resource.revision });
  } catch (error) {
    if (error instanceof PreviewStoreError) throw error;
    throw new PreviewStoreError(503, "The selected database preview could not be confirmed. Check the saved request before retrying.");
  }
}
