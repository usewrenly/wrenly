/** Only fixed backup/migration helper effects can enter cleanup recovery; provisioning and arbitrary commands cannot. */
import type { appDatabaseOperations } from "@wrenly/db";
type Operation = Pick<
  typeof appDatabaseOperations.$inferSelect,
  | "id"
  | "kind"
  | "status"
  | "effect"
  | "completedEffects"
  | "cleanupEffect"
  | "completedCleanupEffects"
>;
/** This permits inspection, not SQL replay or successful completion. Native outcome proof is independently required. */
export function isRecoverableProductionOperation(
  operation: Operation,
): boolean {
  if (
    !["backup", "migrate"].includes(operation.kind) ||
    operation.status !== "interrupted"
  )
    return false;
  const id = operation.id;
  const expected: Record<string, string[]> = {
    "create-network": [`wrenly-database-${id}-network`],
    "create-volume": [`wrenly-database-${id}-data`],
    initialize: [`wrenly-database-${id}-initialize-${id}`],
    "create-container": [`wrenly-database-${id}`],
    "create-socket": [`wrenly-database-socket-${id}`],
    "capture-backup": [`wrenly-database-dump-${id}`],
    "restore-backup": [`wrenly-database-restore-${id}`],
    "apply-migrations": [`wrenly-database-migration-${id}`, `wrenly-laravel-preparation-${id}`],
    "provision-roles": [`wrenly-database-administrator-${id}`],
    "inspect-schema": [`wrenly-database-administrator-${id}`],
    "enforce-policy": [
      `wrenly-database-administrator-${id}`,
      `production-policy-${id}`,
    ],
    "terminate-sessions": [`wrenly-database-administrator-${id}`],
  };
  const effects = [
    ...operation.completedEffects,
    ...(operation.effect ? [operation.effect] : []),
  ];
  const cleanups = [
    ...operation.completedCleanupEffects,
    ...(operation.cleanupEffect ? [operation.cleanupEffect] : []),
  ];
  return (
    effects.length > 0 &&
    effects.length <= 32 &&
    cleanups.length <= 16 &&
    effects.every((effect) =>
      effect.kind === "start"
        ? /^[a-f0-9]{64}$/.test(effect.id)
        : expected[effect.kind]?.includes(effect.id) === true,
    ) &&
    (operation.kind !== "backup" ||
      !effects.some((effect) =>
        ["apply-migrations", "enforce-policy", "terminate-sessions"].includes(
          effect.kind,
        ),
      )) &&
    cleanups.every(
      (effect) =>
        (effect.kind === "close-reader-socket" &&
          effect.id === `wrenly-database-socket-${id}`) ||
        (effect.kind === "terminate-sessions" &&
          effect.id === `wrenly-database-administrator-${id}`),
    )
  );
}
