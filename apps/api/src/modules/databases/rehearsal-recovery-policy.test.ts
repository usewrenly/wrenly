import { expect, test } from "bun:test";
import {
  isFailedDisposableRehearsal,
  isInterruptedRehearsalRecovery,
} from "./rehearsal-recovery-policy";
const id = crypto.randomUUID(),
  resourceId = crypto.randomUUID(),
  projectId = crypto.randomUUID(),
  buildId = crypto.randomUUID();
const resource = {
  id: resourceId,
  projectId,
  environment: "development" as const,
  provider: "local",
  status: "recovery_required" as const,
  schemaDigest: "a".repeat(64),
  runtimeIdentity: {
    version: 1 as const,
    containerId: "b".repeat(64),
    networkId: "c".repeat(64),
    volumeName: "fixture",
    imageId: `sha256:${"d".repeat(64)}`,
  },
};
const pairs = [
  ["create-network", `wrenly-database-${id}-network`],
  ["create-volume", `wrenly-database-${id}-data`],
  ["initialize", `wrenly-database-${id}-initialize-${id}`],
  ["create-container", `wrenly-database-${id}`],
  ["start", "e".repeat(64)],
  ["provision-roles", `wrenly-database-administrator-${id}`],
  ["restore-backup", `wrenly-database-restore-${id}`],
  ["inspect-schema", `wrenly-database-administrator-${id}`],
  ["create-socket", `wrenly-database-socket-${id}`],
];
const operation = {
  id,
  projectId,
  databaseId: resourceId,
  buildId,
  migrationDigest: "f".repeat(64),
  kind: "migrate",
  status: "interrupted" as const,
  effect: {
    kind: "apply-migrations",
    id: `wrenly-database-migration-${id}`,
    startedAt: new Date().toISOString(),
  },
  completedEffects: pairs.map(([kind, id]) => ({
    kind: kind!,
    id: id!,
    startedAt: new Date().toISOString(),
  })),
  cleanupEffect: null,
  completedCleanupEffects: [],
};
const review = {
  operationId: id,
  databaseId: resourceId,
  buildId,
  digest: operation.migrationDigest,
  beforeSchemaDigest: resource.schemaDigest,
  rehearsedSchemaDigest: null,
  completedAt: null,
};
test("only an exact interrupted disposable rehearsal is eligible", () => {
  expect(isFailedDisposableRehearsal(resource, operation, review)).toBe(true);
  for (const changed of [
    {
      ...operation,
      effect: { ...operation.effect, id: resource.runtimeIdentity.containerId },
    },
    {
      ...operation,
      completedEffects: [...operation.completedEffects, operation.effect],
    },
    { ...operation, completedEffects: operation.completedEffects.slice(1) },
    { ...operation, cleanupEffect: operation.effect },
    { ...operation, databaseId: crypto.randomUUID() },
    { ...operation, status: "running" as const },
  ])
    expect(isFailedDisposableRehearsal(resource, changed, review)).toBe(false);
  expect(
    isFailedDisposableRehearsal(resource, operation, {
      ...review,
      rehearsedSchemaDigest: "a".repeat(64),
    }),
  ).toBe(false);
  expect(
    isFailedDisposableRehearsal(resource, operation, {
      ...review,
      digest: "b".repeat(64),
    }),
  ).toBe(false);
  expect(
    isFailedDisposableRehearsal(
      { ...resource, schemaDigest: "b".repeat(64) },
      operation,
      review,
    ),
  ).toBe(false);
  expect(
    isFailedDisposableRehearsal(
      { ...resource, environment: "production" },
      operation,
      review,
    ),
  ).toBe(false);
});

test("interrupted recovery accepts only its own inspector and preserved runtime effects", () => {
  const recoveryId = crypto.randomUUID();
  const recovery = {
    ...operation,
    id: recoveryId,
    kind: "recover-rehearsal",
    completedEffects: [],
    effect: {
      kind: "inspect-rehearsal-operation",
      id,
      startedAt: new Date().toISOString(),
    },
    cleanupEffect: {
      kind: "verify-rehearsal-source",
      id: `wrenly-database-administrator-${recoveryId}`,
      startedAt: new Date().toISOString(),
    },
  };
  expect(isInterruptedRehearsalRecovery(resource, recovery, id)).toBe(true);
  expect(
    isInterruptedRehearsalRecovery(
      resource,
      {
        ...recovery,
        cleanupEffect: {
          ...recovery.cleanupEffect,
          id: `wrenly-database-administrator-${crypto.randomUUID()}`,
        },
      },
      id,
    ),
  ).toBe(false);
  expect(
    isInterruptedRehearsalRecovery(
      resource,
      {
        ...recovery,
        cleanupEffect: {
          ...recovery.cleanupEffect,
          kind: "start-preserved-database",
          id: resource.runtimeIdentity.containerId,
        },
      },
      id,
    ),
  ).toBe(true);
  expect(
    isInterruptedRehearsalRecovery(
      resource,
      {
        ...recovery,
        cleanupEffect: {
          ...recovery.cleanupEffect,
          kind: "start-preserved-database",
          id: "9".repeat(64),
        },
      },
      id,
    ),
  ).toBe(false);
  expect(
    isInterruptedRehearsalRecovery(
      resource,
      { ...recovery, completedEffects: [operation.effect] },
      id,
    ),
  ).toBe(false);
  expect(
    isInterruptedRehearsalRecovery(resource, recovery, crypto.randomUUID()),
  ).toBe(false);
});
