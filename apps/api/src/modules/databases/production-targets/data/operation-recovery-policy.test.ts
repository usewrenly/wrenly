import { expect, test } from "bun:test";
import { isRecoverableProductionOperation } from "./operation-recovery-policy";
const id = crypto.randomUUID();
const operation = { id, kind: "backup", status: "interrupted" as const,
  effect: { kind: "capture-backup", id: `wrenly-database-dump-${id}`, startedAt: new Date().toISOString() },
  completedEffects: [], cleanupEffect: null, completedCleanupEffects: [] };
test("cleanup review accepts only this backup or migration's fixed effects", () => {
  expect(isRecoverableProductionOperation(operation)).toBe(true);
  expect(isRecoverableProductionOperation({ ...operation, kind: "create" })).toBe(false);
  expect(isRecoverableProductionOperation({ ...operation, status: "running" })).toBe(false);
  expect(isRecoverableProductionOperation({ ...operation, effect: { ...operation.effect, id: `wrenly-database-dump-${crypto.randomUUID()}` } })).toBe(false);
  expect(isRecoverableProductionOperation({ ...operation, effect: { ...operation.effect, kind: "apply-migrations", id: `wrenly-database-migration-${id}` } })).toBe(false);
  expect(isRecoverableProductionOperation({ ...operation, kind: "migrate", effect: { ...operation.effect, kind: "apply-migrations", id: `wrenly-database-migration-${id}` } })).toBe(true);
  expect(isRecoverableProductionOperation({ ...operation, cleanupEffect: { ...operation.effect, kind: "close-reader-socket", id: `wrenly-database-socket-${crypto.randomUUID()}` } })).toBe(false);
});
