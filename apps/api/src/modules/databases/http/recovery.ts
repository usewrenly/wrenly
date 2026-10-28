/**
 * COMPONENT: Owner-confirmed database recovery requests
 * PURPOSE: Validate explicit review before an existing recovery service may inspect an interruption.
 * INPUTS: Exact operation/revision/request IDs, recovery kind and affirmative confirmation.
 * OUTPUTS: A saved acknowledgement or a safe failure requiring receipt lookup.
 * STEPS: Reuse bounded authenticated command handling; delegate the reviewed action.
 * EDGE CASES: Receipt reads never repeat recovery; services retain effect/lease/lock checks.
 * ERROR STATES: Unknown outcomes remain unknown. No routes or workers are activated here.
 */
import { DatabaseRecoveryAction } from "@wrenly/db/app-database-action-contract";
import { createDatabaseCommandHandlers, type DatabaseCommandServices, type DatabaseCommandHandlers } from "./command-handlers";

/** The injected admission service must dispatch to the matching fenced recovery operation. */
export function createDatabaseRecoveryHandlers(
  services: DatabaseCommandServices<DatabaseRecoveryAction>, webUrl: string,
): DatabaseCommandHandlers {
  return createDatabaseCommandHandlers<DatabaseRecoveryAction>(DatabaseRecoveryAction, services, webUrl);
}
