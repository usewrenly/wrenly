/** Recognizes only a failed migration on its disposable restore, before a persistent rehearsal receipt exists. */
import type {
  appDatabases,
  appDatabaseOperations,
  appDatabaseMigrations,
} from "@wrenly/db";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
type Resource = Pick<
  typeof appDatabases.$inferSelect,
  | "id"
  | "projectId"
  | "environment"
  | "provider"
  | "status"
  | "runtimeIdentity"
  | "schemaDigest"
> & { providerIdentity?: unknown };

/** Production has no local database container; its immutable cluster binding identifies the preserved resource. */
function hasPreservedResource(resource: Resource): boolean {
  if (resource.environment === "development")
    return resource.provider === "local" && resource.runtimeIdentity !== null;
  if (
    resource.environment !== "production" ||
    resource.provider !== "postgres-cluster" ||
    resource.runtimeIdentity !== null
  )
    return false;
  try {
    parseProductionResourceBinding(resource.id, resource.providerIdentity);
    return true;
  } catch {
    return false;
  }
}
type Operation = Pick<
  typeof appDatabaseOperations.$inferSelect,
  | "id"
  | "projectId"
  | "databaseId"
  | "kind"
  | "status"
  | "effect"
  | "completedEffects"
  | "cleanupEffect"
  | "completedCleanupEffects"
  | "buildId"
  | "migrationDigest"
>;
type Review = Pick<
  typeof appDatabaseMigrations.$inferSelect,
  | "operationId"
  | "databaseId"
  | "buildId"
  | "digest"
  | "beforeSchemaDigest"
  | "rehearsedSchemaDigest"
  | "completedAt"
>;
/** Unknown sequences remain blocked; a null rehearsal receipt alone cannot prove isolation. */
export function isFailedDisposableRehearsal(
  resource: Resource,
  operation: Operation,
  review: Review,
): boolean {
  const id = operation.id;
  const expected = [
    ["create-network", `wrenly-database-${id}-network`],
    ["create-volume", `wrenly-database-${id}-data`],
    ["initialize", `wrenly-database-${id}-initialize-${id}`],
    ["create-container", `wrenly-database-${id}`],
    ["start", null],
    ["provision-roles", `wrenly-database-administrator-${id}`],
    ["restore-backup", `wrenly-database-restore-${id}`],
    ["inspect-schema", `wrenly-database-administrator-${id}`],
    ["create-socket", `wrenly-database-socket-${id}`],
  ];
  return (
    hasPreservedResource(resource) &&
    resource.status === "recovery_required" &&
    resource.id !== id &&
    operation.projectId === resource.projectId &&
    operation.databaseId === resource.id &&
    operation.kind === "migrate" &&
    operation.status === "interrupted" &&
    operation.cleanupEffect === null &&
    operation.completedCleanupEffects.length === 0 &&
    review.operationId === id &&
    review.databaseId === resource.id &&
    review.buildId === operation.buildId &&
    review.digest === operation.migrationDigest &&
    review.beforeSchemaDigest !== null &&
    review.beforeSchemaDigest === resource.schemaDigest &&
    review.rehearsedSchemaDigest === null &&
    review.completedAt === null &&
    operation.effect?.kind === "apply-migrations" &&
    operation.effect.id === `wrenly-database-migration-${id}` &&
    operation.completedEffects.length === expected.length &&
    operation.completedEffects.every((effect, index) => {
      const pair = expected[index]!;
      return (
        effect.kind === pair[0] &&
        (pair[1] === null
          ? /^[a-f0-9]{64}$/.test(effect.id) &&
            effect.id !== resource.runtimeIdentity?.containerId
          : effect.id === pair[1])
      );
    })
  );
}

/** A prior recovery may touch only disposable cleanup, its inspector, and the exact preserved runtime. */
export function isInterruptedRehearsalRecovery(
  resource: Resource,
  operation: Operation,
  migrationId: string,
): boolean {
  if (
    operation.kind !== "recover-rehearsal" ||
    operation.status !== "interrupted" ||
    operation.databaseId !== resource.id ||
    operation.projectId !== resource.projectId ||
    operation.effect?.kind !== "inspect-rehearsal-operation" ||
    operation.effect.id !== migrationId ||
    operation.completedEffects.length !== 0 ||
    !hasPreservedResource(resource)
  )
    return false;
  const allowed = (effect: { kind: string; id: string }): boolean => {
    const disposable = {
      "cleanup-validation-application": `wrenly-database-application-${migrationId}`,
      "cleanup-validation-socket": `wrenly-database-socket-${migrationId}`,
      "cleanup-validation-database": `wrenly-database-${migrationId}`,
    };
    if (effect.kind in disposable)
      return effect.id === disposable[effect.kind as keyof typeof disposable];
    if (effect.kind === "verify-rehearsal-source")
      return effect.id === `wrenly-database-administrator-${operation.id}`;
    if (effect.kind === "start-preserved-database")
      return (
        resource.environment === "development" &&
        effect.id === resource.runtimeIdentity?.containerId
      );
    return (
      effect.kind === "cleanup-prior-inspector" &&
      /^wrenly-database-administrator-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        effect.id,
      )
    );
  };
  return (
    operation.completedCleanupEffects.length <= 32 &&
    operation.completedCleanupEffects.every(allowed) &&
    (operation.cleanupEffect === null || allowed(operation.cleanupEffect))
  );
}
