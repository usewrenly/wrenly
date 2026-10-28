/**
 * COMPONENT: Viewer authority snapshot
 * PURPOSE: Bind a bounded database read to current project access and a ready resource.
 * INPUTS: Active request actor, project and validated resource/environment/revision.
 * OUTPUTS: Non-secret authority identity, or refusal before opening a socket.
 * STEPS: Check project capabilities, select the exact resource, verify ready/revision,
 * recheck capabilities, then return the project's access revision for response fencing.
 * EDGE CASES: Same role after sharing changes still requires a new access revision.
 * ERROR STATES: Stale/stopped/missing resources never fall back to another environment.
 */
import { and, eq } from "drizzle-orm";
import { appDatabases, projects, type db } from "@wrenly/db";
import { readProjectCapabilities } from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";
import {
  requireDatabaseViewPermission,
  type DatabaseViewRequest,
} from "./view-contract";

export type ViewDatabase =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DatabaseViewAuthority {
  accessRevision: string;
  resourceId: string;
  resourceRevision: string;
}

/** Called before execution and again before returning rows; never decrypts credentials. */
export async function readDatabaseViewAuthority(
  database: ViewDatabase,
  projectId: string,
  actorId: string,
  input: DatabaseViewRequest,
): Promise<DatabaseViewAuthority> {
  try {
    const access = await readProjectCapabilities(database, projectId, actorId);
    requireDatabaseViewPermission(access, input);
    const [row] = await database
      .select({
        id: appDatabases.id,
        revision: appDatabases.revision,
        status: appDatabases.status,
        accessRevision: projects.accessRevision,
      })
      .from(appDatabases)
      .innerJoin(projects, eq(projects.id, appDatabases.projectId))
      .where(
        and(
          eq(appDatabases.id, input.resourceId),
          eq(appDatabases.projectId, projectId),
          eq(appDatabases.environment, input.environment),
        ),
      )
      .limit(1);
    if (!row) throw new AppDatabaseError(404, "Database not found.");
    if (row.revision !== input.revision || row.status !== "ready")
      throw new AppDatabaseError(
        409,
        "Reload the database's current ready revision before inspecting it.",
      );
    const current = await readProjectCapabilities(database, projectId, actorId);
    requireDatabaseViewPermission(current, input);
    if (current?.role !== access?.role)
      throw new AppDatabaseError(
        409,
        "Project access changed. Reload before inspecting data.",
      );
    return {
      accessRevision: row.accessRevision,
      resourceId: row.id,
      resourceRevision: row.revision,
    };
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "Database access could not be verified. Try reloading its status.",
    );
  }
}
