/** Read-only viewer inputs never accept SQL, connection strings or provider commands. */
import type { ProjectCapabilities } from "../../projects/access/project-access";
import { DatabaseViewerSelection as DatabaseViewRequest } from "@wrenly/db/app-database-viewer-contract";
export { DatabaseViewRequest };
import { AppDatabaseError } from "../database-contract";

/** Schema access follows project read authority; rows require environment-specific rights. */
export function requireDatabaseViewPermission(
  access: ProjectCapabilities | null,
  input: DatabaseViewRequest,
): void {
  if (!access) throw new AppDatabaseError(404, "Project not found.");
  if (
    input.rows &&
    !(input.environment === "production" ? access.manage : access.contribute)
  )
    throw new AppDatabaseError(
      403,
      input.environment === "production"
        ? "Only the project owner can inspect Production rows."
        : "Development rows require project Owner or Editor access.",
    );
}
