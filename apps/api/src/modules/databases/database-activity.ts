import { MaintenanceAttempt } from "@wrenly/db/production-maintenance-attempt";
// Shared access/admission checks preserve queued and uncertain database effects as blockers.
import { and, eq, inArray, or, ne, notInArray } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  appDatabaseOperations,
  productionDatabaseConnections,
  productionRuntimeHosts,
  productionDatabaseProvisions,
  projects,
  productionRuntimeMaintenanceAttempts,
} from "@wrenly/db";
import { AppDatabaseError } from "./database-contract";
const BLOCKING = ["queued", "running", "interrupted"] as const;
/** Run under the shared queue locks. Unknown restart effects block replacing infrastructure or suspending its owner. */
export async function hasUnfinishedMaintenance(
  database: Pick<typeof db, "select">,
  ownerId?: string,
): Promise<boolean> {
  try {
    const attempts = await database
      .select({ journal: productionRuntimeMaintenanceAttempts.journal })
      .from(productionRuntimeMaintenanceAttempts)
      .innerJoin(
        projects,
        eq(projects.id, productionRuntimeMaintenanceAttempts.projectId),
      )
      .where(ownerId ? eq(projects.userId, ownerId) : undefined);
    return attempts.some(
      (row) => !["success", "reconciled"].includes(MaintenanceAttempt.parse(row.journal).status),
    );
  } catch {
    throw new AppDatabaseError(
      503,
      "Runtime maintenance state could not be verified.",
    );
  }
}
/** Call under a project-work queue lock; interrupted operations retain the fence. */
export async function hasDatabaseWork(
  database: Pick<typeof db, "select">,
  projectId: string,
  ownMaintenanceAttemptId?: string | readonly string[],
): Promise<boolean> {
  try {
    const attempts = await database
      .select({
        id: productionRuntimeMaintenanceAttempts.id,
        journal: productionRuntimeMaintenanceAttempts.journal,
      })
      .from(productionRuntimeMaintenanceAttempts)
      .where(
        and(
          eq(productionRuntimeMaintenanceAttempts.projectId, projectId),
          ownMaintenanceAttemptId
            ? Array.isArray(ownMaintenanceAttemptId) ? notInArray(productionRuntimeMaintenanceAttempts.id, [...ownMaintenanceAttemptId]) : ne(productionRuntimeMaintenanceAttempts.id, ownMaintenanceAttemptId as string)
            : undefined,
        ),
      );
    // Unknown/unfinished restart effects fence lifecycle changes just like uncertain SQL.
    if (
      attempts.some(
        (row) => !["success", "reconciled"].includes(MaintenanceAttempt.parse(row.journal).status),
      )
    )
      return true;
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
    if (row) return true;
    const [provision] = await database
      .select({ id: productionDatabaseProvisions.id })
      .from(productionDatabaseProvisions)
      .where(
        and(
          eq(productionDatabaseProvisions.projectId, projectId),
          inArray(productionDatabaseProvisions.status, [
            "queued",
            "creating",
            "created",
            "needs_review",
          ]),
        ),
      )
      .limit(1);
    return Boolean(provision);
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
    if (await hasUnfinishedMaintenance(database, actorId)) return true;
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
    if (row) return true;
    const [provision] = await database
      .select({ id: productionDatabaseProvisions.id })
      .from(productionDatabaseProvisions)
      .innerJoin(
        projects,
        eq(projects.id, productionDatabaseProvisions.projectId),
      )
      .where(
        and(
          inArray(productionDatabaseProvisions.status, [
            "queued",
            "creating",
            "created",
            "needs_review",
          ]),
          or(
            eq(productionDatabaseProvisions.actorId, actorId),
            eq(projects.userId, actorId),
          ),
        ),
      )
      .limit(1);
    if (provision) return true;
    const [connection] = await database
      .select({ id: productionDatabaseConnections.id })
      .from(productionDatabaseConnections)
      .where(
        and(
          eq(productionDatabaseConnections.actorId, actorId),
          inArray(productionDatabaseConnections.status, [
            "queued",
            "checking",
            "needs_review",
          ]),
        ),
      )
      .limit(1);
    if (connection) return true;
    const [host] = await database
      .select({ id: productionRuntimeHosts.id })
      .from(productionRuntimeHosts)
      .where(
        and(
          eq(productionRuntimeHosts.actorId, actorId),
          inArray(productionRuntimeHosts.status, [
            "queued",
            "checking",
            "needs_review",
          ]),
        ),
      )
      .limit(1);
    return Boolean(host);
  } catch {
    throw new AppDatabaseError(
      503,
      "Member database work could not be verified.",
    );
  }
}
