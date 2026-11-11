/** Connects Production resource commands to the current request's verified session, never an actor chosen in JSON. */
import type { db } from "@wrenly/db";
import type { DatabaseAction } from "@wrenly/db/app-database-action-contract";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { AppDatabaseError } from "../../database-contract";
import { admitProductionDatabaseAction } from "./actions";
/** HTTP session resolution captures this identity in the request scope before command admission. */
export function requireProductionActionPrincipal(
  actorId: string,
): AccessPrincipal {
  const principal = accessContext.getStore()?.principal;
  if (!principal || principal.userId !== actorId)
    throw new AppDatabaseError(
      403,
      "Your session changed. Sign in again before managing Production.",
    );
  return principal;
}
export async function admitProductionResourceCommand(
  database: typeof db,
  projectId: string,
  actorId: string,
  action: DatabaseAction,
): Promise<Awaited<ReturnType<typeof admitProductionDatabaseAction>>> {
  try {
    return await admitProductionDatabaseAction(
      database,
      requireProductionActionPrincipal(actorId),
      projectId,
      action,
    );
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "The Production request could not be confirmed. Check its saved acknowledgement before retrying.",
    );
  }
}
