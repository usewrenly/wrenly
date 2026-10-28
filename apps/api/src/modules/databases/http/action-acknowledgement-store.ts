// A lost browser response must be recoverable without admitting another operation.
// Current owners may read their own saved receipts, including on archived projects;
// receipt lookup never reruns work or returns original request/credential material.
import { and, eq } from "drizzle-orm";
import { appDatabaseOperations, projects, type db } from "@wrenly/db";
import type { DatabaseActionAcknowledgement } from "@wrenly/db/app-database-action-contract";
import { readProjectCapabilities } from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";

/** Null means no saved receipt at this instant, not proof an in-flight admission cannot still commit. */
export async function readDatabaseActionAcknowledgement(
  database: typeof db, projectId: string, actorId: string, requestId: string,
): Promise<DatabaseActionAcknowledgement | null> {
  try {
    const access = await readProjectCapabilities(database, projectId, actorId);
    if (!access) throw new AppDatabaseError(404, "Project not found.");
    if (access.role !== "owner") throw new AppDatabaseError(403, "Only the owner can inspect database actions.");
    const [authority] = await database.select({ revision: projects.accessRevision }).from(projects)
      .where(eq(projects.id, projectId)).limit(1);
    if (!authority) throw new AppDatabaseError(404, "Project not found.");
    const [receipt] = await database.select({ operationId: appDatabaseOperations.id, resourceId: appDatabaseOperations.databaseId })
      .from(appDatabaseOperations).where(and(eq(appDatabaseOperations.projectId, projectId),
        eq(appDatabaseOperations.actorId, actorId), eq(appDatabaseOperations.requestId, requestId))).limit(1);
    const current = await readProjectCapabilities(database, projectId, actorId);
    const [revision] = await database.select({ revision: projects.accessRevision }).from(projects)
      .where(eq(projects.id, projectId)).limit(1);
    if (current?.role !== "owner" || revision?.revision !== authority.revision)
      throw new AppDatabaseError(403, "Project access changed while checking the action.");
    return receipt ? { ...receipt, replayed: true } : null;
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(503, "Saved database acknowledgement could not be verified.");
  }
}
