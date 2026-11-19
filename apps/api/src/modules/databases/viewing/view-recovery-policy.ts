/** Pure effect checks shared by recovery review and execution; cleanup never authorizes replaying a query. */
import type { appDatabaseOperations } from "@wrenly/db";
type Operation = Pick<
  typeof appDatabaseOperations.$inferSelect,
  | "id"
  | "kind"
  | "effect"
  | "completedEffects"
  | "cleanupEffect"
  | "completedCleanupEffects"
>;
export function isRecoverableDatabaseRead(operation: Operation): boolean {
  const effects = [
    ...operation.completedEffects,
    ...(operation.effect ? [operation.effect] : []),
  ];
  const cleanup = [
    ...operation.completedCleanupEffects,
    ...(operation.cleanupEffect ? [operation.cleanupEffect] : []),
  ];
  return (
    operation.kind === "read" &&
    effects.length <= 2 &&
    cleanup.length <= 1 &&
    effects.every(
      (effect) =>
        (effect.kind === "create-socket" &&
          effect.id === `wrenly-database-socket-${operation.id}`) ||
        (effect.kind === "read-database" &&
          effect.id === `wrenly-database-query-${operation.id}`),
    ) &&
    cleanup.every(
      (effect) =>
        effect.kind === "close-reader-socket" &&
        effect.id === `wrenly-database-socket-${operation.id}`,
    )
  );
}
