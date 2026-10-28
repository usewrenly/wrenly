// Shared access/admission checks preserve queued and uncertain database effects as blockers.
import { and, eq, inArray, or } from "drizzle-orm";
import type { db } from "@wrenly/db";
import { appDatabaseOperations, projects } from "@wrenly/db";
import { AppDatabaseError } from "./database-contract";
const BLOCKING = ["queued", "running", "interrupted"] as const;
/** Call under a project-work queue lock; interrupted operations retain the fence. */
export async function hasDatabaseWork(
  database: Pick<typeof db, "select">,
  projectId: string,
): Promise<boolean> {
  try {
    const [row] = await database
      .select({ id: appDatabaseOperations.id })
      .from(appDatabaseOperations)
      .where(
        and(
          eq(appDatabaseOperations.projectId, projectId),
          inArray(appDatabaseOperations.status, [...BLOCKING]),
        ),
      )
      .limit(1);
    return Boolean(row);
  } catch {
    throw new AppDatabaseError(
      503,
      "Database operation state could not be verified.",
    );
  }
}
/** Account suspension cannot invalidate the actor/owner of queued or uncertain database effects. */
export async function hasMemberDatabaseWork(
  database: Pick<typeof db, "select">,
  actorId: string,
): Promise<boolean> {
  try {
    const [row] = await database
      .select({ id: appDatabaseOperations.id })
      .from(appDatabaseOperations)
      .innerJoin(projects, eq(projects.id, appDatabaseOperations.projectId))
      .where(
        and(
          inArray(appDatabaseOperations.status, [...BLOCKING]),
          or(
            eq(appDatabaseOperations.actorId, actorId),
            eq(projects.userId, actorId),
          ),
        ),
      )
      .limit(1);
    return Boolean(row);
  } catch {
    throw new AppDatabaseError(
      503,
      "Member database work could not be verified.",
    );
  }
}
