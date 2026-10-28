import { expect, test } from "bun:test";
import { databaseRecoveryChoices } from "./database-recovery-review";
type Resource = Parameters<typeof databaseRecoveryChoices>[0];
type Operation = Parameters<typeof databaseRecoveryChoices>[1];
const resource: Resource = { id: crypto.randomUUID(), projectId: crypto.randomUUID(), environment: "development", provider: "local",
  status: "recovery_required", runtimeIdentity: null };
const operation: Operation = { id: crypto.randomUUID(), projectId: resource.projectId, databaseId: resource.id, kind: "create",
  status: "interrupted", effect: null, completedEffects: [], cleanupEffect: null, completedCleanupEffects: [] };
const identity = { version: 1 as const, containerId: "a".repeat(64), networkId: "b".repeat(64), volumeName: "fixture", imageId: `sha256:${"c".repeat(64)}` };
test("effect-free recovery refuses changed identities, completed effects and cleanup uncertainty", () => {
  expect(databaseRecoveryChoices(resource, operation)).toEqual(["recover-before-effect"]);
  for (const changed of [{ ...operation, projectId: crypto.randomUUID() }, { ...operation, status: "running" as const },
    { ...operation, effect: { kind: "create", id: "foreign", startedAt: new Date().toISOString() } },
    { ...operation, cleanupEffect: { kind: "cleanup", id: "unknown", startedAt: new Date().toISOString() } }])
    expect(databaseRecoveryChoices(resource, changed)).toEqual([]);
});
test("runtime and reader review require exact saved external-effect identities", () => {
  const saved = { ...resource, runtimeIdentity: identity };
  const effect = { kind: "start", id: identity.containerId, startedAt: new Date().toISOString() };
  expect(databaseRecoveryChoices(saved, { ...operation, kind: "start", effect })).toEqual(["recover-runtime-state"]);
  expect(databaseRecoveryChoices(saved, { ...operation, kind: "start", effect: { ...effect, id: "foreign" } })).toEqual([]);
  const read = { ...operation, kind: "read" as const, effect: { ...effect, kind: "read-database", id: `wrenly-database-query-${operation.id}` } };
  expect(databaseRecoveryChoices(saved, read)).toEqual(["recover-read"]);
  expect(databaseRecoveryChoices(saved, { ...read, effect: { ...read.effect, id: "foreign" } })).toEqual([]);
  expect(databaseRecoveryChoices({ ...saved, environment: "production" }, read)).toEqual([]);
  expect(databaseRecoveryChoices({ ...saved, status: "ready" }, { ...operation, kind: "validate-application" })).toEqual(["recover-validation"]);
  expect(databaseRecoveryChoices(saved, { ...operation, kind: "validate-application" })).toEqual([]);
});
