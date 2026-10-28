/**
 * COMPONENT: Reviewed recovery dispatch
 * PURPOSE: Connect a confirmed browser action to the matching existing recovery service.
 * INPUTS: Current actor/project and strict operation/revision/request identity.
 * OUTPUTS: The durable recovery receipt; never an automatic retry of the old operation.
 * STEPS: Validate confirmation, remove HTTP-only fields, select the exact recovery path.
 * EDGE CASES: Each service retains owner/replay/lease/kernel-lock and effect checks.
 * ERROR STATES: Preserve known access/conflict failures; unknown failures require reconciliation.
 */
import type { db } from "@wrenly/db";
import { DatabaseRecoveryAction, type DatabaseActionAcknowledgement } from "@wrenly/db/app-database-action-contract";
import { AccessDeniedError } from "../auth/access/access-policy";
import { ProjectAccessError } from "../projects/access/project-access";
import { AppDatabaseError } from "./database-contract";
import { recoverInspectedDatabaseAction, recoverUnstartedDatabaseAction } from "./database-recovery";
import { recoverDatabaseValidation } from "./validation/validation-recovery";
import { recoverDatabaseRead } from "./viewing/view-recovery";

/** Confirmation authorizes inspection only; it cannot waive the interrupted operation's fences. */
export async function admitDatabaseRecovery(
  database: typeof db, projectId: string, actorId: string, body: unknown,
): Promise<DatabaseActionAcknowledgement> {
  try {
    const parsed = DatabaseRecoveryAction.safeParse(body);
    if (!parsed.success) throw new AppDatabaseError(400, "Confirm the exact interrupted operation and current revision.");
    const { requestId, operationId, expectedRevision, kind } = parsed.data;
    const review = { requestId, operationId, expectedRevision };
    switch (kind) {
      case "recover-before-effect": return await recoverUnstartedDatabaseAction(database, projectId, actorId, review);
      case "recover-runtime-state": return await recoverInspectedDatabaseAction(database, projectId, actorId, review);
      case "recover-validation": return await recoverDatabaseValidation(database, projectId, actorId, review);
      case "recover-read": return await recoverDatabaseRead(database, projectId, actorId, review);
    }
  } catch (error) {
    if (error instanceof AppDatabaseError || error instanceof ProjectAccessError || error instanceof AccessDeniedError) throw error;
    throw new AppDatabaseError(503, "Recovery could not be confirmed. Check the same saved request before retrying.");
  }
}
