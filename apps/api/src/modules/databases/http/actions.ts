// Lifecycle actions share the same bounded session/origin/receipt rules as recovery.
import { DatabaseAction } from "@wrenly/db/app-database-action-contract";
import { createDatabaseCommandHandlers, type DatabaseCommandServices, type DatabaseCommandHandlers } from "./command-handlers";

/** Services retain transactional ownership, revision and exact replay checks. */
export function createDatabaseActionHandlers(
  services: DatabaseCommandServices<DatabaseAction>, webUrl: string,
): DatabaseCommandHandlers {
  return createDatabaseCommandHandlers<DatabaseAction>(DatabaseAction, services, webUrl);
}
