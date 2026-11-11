import { expect, test } from "bun:test";
import { databaseRecoveryChoices } from "./database-recovery-review";
type Resource = Parameters<typeof databaseRecoveryChoices>[0];
type Operation = Parameters<typeof databaseRecoveryChoices>[1];
const resource: Resource = {
  id: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  environment: "development",
  provider: "local",
  status: "recovery_required",
  runtimeIdentity: null,
};
const operation: Operation = {
  id: crypto.randomUUID(),
  projectId: resource.projectId,
  databaseId: resource.id,
  kind: "create",
  status: "interrupted",
  effect: null,
  completedEffects: [],
  cleanupEffect: null,
  completedCleanupEffects: [],
};
const identity = {
  version: 1 as const,
  containerId: "a".repeat(64),
  networkId: "b".repeat(64),
  volumeName: "fixture",
  imageId: `sha256:${"c".repeat(64)}`,
};
test("effect-free recovery refuses changed identities, completed effects and cleanup uncertainty", () => {
  expect(databaseRecoveryChoices(resource, operation)).toEqual([
    "recover-before-effect",
  ]);
  for (const changed of [
    { ...operation, projectId: crypto.randomUUID() },
    { ...operation, status: "running" as const },
    {
      ...operation,
      effect: {
        kind: "create",
        id: "foreign",
        startedAt: new Date().toISOString(),
      },
    },
    {
      ...operation,
      cleanupEffect: {
        kind: "cleanup",
        id: "unknown",
        startedAt: new Date().toISOString(),
      },
    },
  ])
    expect(databaseRecoveryChoices(resource, changed)).toEqual([]);
});
test("runtime and reader review require exact saved external-effect identities", () => {
  const saved = { ...resource, runtimeIdentity: identity };
  const effect = {
    kind: "start",
    id: identity.containerId,
    startedAt: new Date().toISOString(),
  };
  expect(
    databaseRecoveryChoices(saved, { ...operation, kind: "start", effect }),
  ).toEqual(["recover-runtime-state"]);
  expect(
    databaseRecoveryChoices(saved, {
      ...operation,
      kind: "start",
      effect: { ...effect, id: "foreign" },
    }),
  ).toEqual([]);
  const read = {
    ...operation,
    kind: "read" as const,
    effect: {
      ...effect,
      kind: "read-database",
      id: `wrenly-database-query-${operation.id}`,
    },
  };
  expect(databaseRecoveryChoices(saved, read)).toEqual(["recover-read"]);
  expect(
    databaseRecoveryChoices(saved, {
      ...read,
      effect: { ...read.effect, id: "foreign" },
    }),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices({ ...saved, environment: "production" }, read),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(
      { ...saved, status: "ready" },
      { ...operation, kind: "validate-application" },
    ),
  ).toEqual(["recover-validation"]);
  expect(
    databaseRecoveryChoices(saved, {
      ...operation,
      kind: "validate-application",
    }),
  ).toEqual([]);
});

test("Production effect-free recovery requires its exact complete binding and preserves uncertainty", () => {
  const production: Resource = {
    ...resource,
    environment: "production",
    provider: "postgres-cluster",
    providerIdentity: {
      version: "1",
      provider: "postgres-cluster",
      connectionId: crypto.randomUUID(),
      clusterId: "12345",
      database: `wrenly_${resource.id.replaceAll("-", "")}`,
      networkId: "a".repeat(64),
    },
  };
  const backup: Operation = { ...operation, kind: "backup" };
  expect(databaseRecoveryChoices(production, backup)).toEqual([
    "recover-before-effect",
  ]);
  expect(
    databaseRecoveryChoices(
      {
        ...production,
        providerIdentity: {
          ...production.providerIdentity,
          database: "wrenly_" + "b".repeat(32),
        },
      },
      backup,
    ),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(production, { ...backup, kind: "create" }),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(production, {
      ...backup,
      effect: {
        kind: "capture-backup",
        id: "uncertain",
        startedAt: new Date().toISOString(),
      },
    }),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(production, {
      ...backup,
      completedCleanupEffects: [
        {
          kind: "close-reader-socket",
          id: "closed",
          startedAt: new Date().toISOString(),
        },
      ],
    }),
  ).toEqual([]);
});

test("Production availability inspection requires only the original exact stop/start effect", () => {
  const production: Resource = {
    ...resource,
    environment: "production",
    provider: "postgres-cluster",
    providerIdentity: {
      version: "1",
      provider: "postgres-cluster",
      connectionId: crypto.randomUUID(),
      clusterId: "12345",
      database: `wrenly_${resource.id.replaceAll("-", "")}`,
      networkId: "a".repeat(64),
    },
  };
  const stop: Operation = {
    ...operation,
    kind: "stop",
    effect: {
      kind: "stop",
      id: `production-availability-${operation.id}`,
      startedAt: new Date().toISOString(),
    },
  };
  expect(databaseRecoveryChoices(production, stop)).toEqual([
    "recover-runtime-state",
  ]);
  expect(
    databaseRecoveryChoices(production, {
      ...stop,
      effect: { ...stop.effect!, id: "foreign" },
    }),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(production, {
      ...stop,
      completedEffects: [
        {
          kind: "apply-migrations",
          id: "unrelated",
          startedAt: new Date().toISOString(),
        },
      ],
    }),
  ).toEqual([]);
});

test("Production reader cleanup permits only the exact read helper and socket", () => {
  const production: Resource = {
    ...resource,
    environment: "production",
    provider: "postgres-cluster",
    providerIdentity: {
      version: "1",
      provider: "postgres-cluster",
      connectionId: crypto.randomUUID(),
      clusterId: "12345",
      database: `wrenly_${resource.id.replaceAll("-", "")}`,
      networkId: "a".repeat(64),
    },
  };
  const read: Operation = {
    ...operation,
    kind: "read",
    effect: {
      kind: "read-database",
      id: `wrenly-database-query-${operation.id}`,
      startedAt: new Date().toISOString(),
    },
    cleanupEffect: {
      kind: "close-reader-socket",
      id: `wrenly-database-socket-${operation.id}`,
      startedAt: new Date().toISOString(),
    },
  };
  expect(databaseRecoveryChoices(production, read)).toEqual(["recover-read"]);
  expect(
    databaseRecoveryChoices(production, {
      ...read,
      effect: { ...read.effect!, id: "foreign" },
    }),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(production, { ...read, kind: "migrate" }),
  ).toEqual([]);
  expect(
    databaseRecoveryChoices(production, {
      ...read,
      cleanupEffect: { ...read.cleanupEffect!, kind: "cleanup" },
    }),
  ).toEqual([]);
});
