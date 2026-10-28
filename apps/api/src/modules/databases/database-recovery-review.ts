/** Review projects recovery choices from durable evidence; it never inspects Docker or resolves an interruption. */
import { and, eq } from "drizzle-orm";
import { appDatabases, appDatabaseOperations, appDatabaseValidations, type db } from "@wrenly/db";
import { DatabaseRecoveryReview } from "@wrenly/db/app-database-resource-contract";
import { requireProjectCapability, ProjectAccessError } from "../projects/access/project-access";
import { AccessDeniedError } from "../auth/access/access-policy";
import { AppDatabaseError } from "./database-contract";
import { lockDatabaseQueues, requireDatabaseProjectIdle } from "./database-store";
type Operation = typeof appDatabaseOperations.$inferSelect;
type Resource = typeof appDatabases.$inferSelect;
/** A choice permits an inspection attempt, not a guarantee that external identity/cleanup checks will pass. */
export function databaseRecoveryChoices(resource: Pick<Resource, "id" | "projectId" | "status" | "environment" | "provider" | "runtimeIdentity">, operation: Pick<Operation, "id" | "projectId" | "databaseId" | "status" | "kind" | "effect" | "completedEffects" | "cleanupEffect" | "completedCleanupEffects">): DatabaseRecoveryReview["choices"] {
  if (resource.environment !== "development" || resource.provider !== "local" ||
      operation.status !== "interrupted" || operation.databaseId !== resource.id || operation.projectId !== resource.projectId) return [];
  if (operation.kind === "validate-application") return resource.status === "ready" ? ["recover-validation"] : [];
  if (resource.status !== "recovery_required") return [];
  if (operation.kind === "read") {
    const effects = [...operation.completedEffects, ...(operation.effect ? [operation.effect] : [])];
    const cleanup = [...operation.completedCleanupEffects, ...(operation.cleanupEffect ? [operation.cleanupEffect] : [])];
    if (resource.runtimeIdentity && effects.length <= 2 && cleanup.length <= 1 && effects.every(effect =>
      (effect.kind === "create-socket" && effect.id === `wrenly-database-socket-${operation.id}`) ||
      (effect.kind === "read-database" && effect.id === `wrenly-database-query-${operation.id}`)) && cleanup.every(effect =>
        effect.kind === "close-reader-socket" && effect.id === `wrenly-database-socket-${operation.id}`)) return ["recover-read"];
    return [];
  }
  if (operation.cleanupEffect !== null || operation.completedCleanupEffects.length) return [];
  const effects = [...operation.completedEffects, ...(operation.effect ? [operation.effect] : [])];
  if (!effects.length && ["create", "start", "stop", "backup", "migrate"].includes(operation.kind) &&
      (operation.kind === "create" ? resource.runtimeIdentity === null : resource.runtimeIdentity !== null)) return ["recover-before-effect"];
  if (resource.runtimeIdentity && ["start", "stop"].includes(operation.kind) && effects.every(effect =>
    effect.kind === operation.kind && effect.id === resource.runtimeIdentity?.containerId)) return ["recover-runtime-state"];
  return [];
}
/** Current owner and immutable operation identity are checked under the same ordered admission locks. */
export async function readDatabaseRecoveryReview(database: typeof db, projectId: string, actorId: string,
  resourceId: string, operationId: string): Promise<DatabaseRecoveryReview> {
  try {
    return await database.transaction(async tx => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      await requireDatabaseProjectIdle(tx, projectId);
      const [resource] = await tx.select().from(appDatabases).where(and(eq(appDatabases.id, resourceId), eq(appDatabases.projectId, projectId)));
      const [operation] = await tx.select().from(appDatabaseOperations).where(and(eq(appDatabaseOperations.id, operationId),
        eq(appDatabaseOperations.databaseId, resourceId), eq(appDatabaseOperations.projectId, projectId)));
      if (!resource || !operation) throw new AppDatabaseError(404, "Database operation not found.");
      let choices = databaseRecoveryChoices(resource, operation);
      if (choices[0] === "recover-validation") {
        const [validation] = await tx.select({ id: appDatabaseValidations.operationId }).from(appDatabaseValidations)
          .where(eq(appDatabaseValidations.operationId, operationId)).limit(1);
        if (!validation) choices = [];
      }
      return DatabaseRecoveryReview.parse({ projectId, resourceId, revision: resource.revision, operationId, choices });
    });
  } catch (error) {
    if (error instanceof AppDatabaseError || error instanceof ProjectAccessError || error instanceof AccessDeniedError) throw error;
    throw new AppDatabaseError(503, "Recovery review could not be verified.");
  }
}
