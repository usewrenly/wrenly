import { expect, test } from "bun:test";
import {
  executeProductionRuntimeCoordinator,
  type ProductionRuntimeCoordinator,
} from "./executor";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
function fixture() {
  const binding: ProductionPublishingBinding = {
    version: 1,
    deploymentId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    buildId: crypto.randomUUID(),
    sourceSha256: "a".repeat(64),
    resourceId: crypto.randomUUID(),
    resourceRevision: crypto.randomUUID(),
    schemaDigest: "b".repeat(64),
    migrationDigest: "c".repeat(64),
    connectionId: crypto.randomUUID(),
    clusterId: "123",
    hostConnectionId: crypto.randomUUID(),
    dockerId: "fixture-daemon",
    serverId: "server",
    principal: {
      userId: "owner",
      sessionId: "session",
      revision: crypto.randomUUID(),
      accessRevision: crypto.randomUUID(),
    },
  };
  let journal: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  const token = crypto.randomUUID(),
    calls: string[] = [];
  const image = `sha256:${"d".repeat(64)}`;
  const services: ProductionRuntimeCoordinator = {
    load: async () => structuredClone({ binding, journal }),
    begin: async () => {
      journal = beginProductionPublishingEffect(
        binding,
        journal,
        token,
        new Date(),
      );
      return journal.pending!;
    },
    acknowledge: async (receipt) => {
      journal = acknowledgeProductionPublishingEffect(
        binding,
        journal,
        receipt,
        token,
      );
    },
    assertHeld: async () => {},
    perform: async ({ effect }) => {
      calls.push(effect.step);
      switch (effect.step) {
        case "http-volume":
          return {
            step: effect.step,
            name: `wrenly-deployment-http-${binding.deploymentId}`,
            createdAt: new Date().toISOString(),
          };
        case "database-volume":
          return {
            step: effect.step,
            name: `wrenly-deployment-db-${binding.deploymentId}`,
            createdAt: new Date().toISOString(),
          };
        case "broker-network":
          return { step: effect.step, networkId: "e".repeat(64) };
        case "broker-start":
          return {
            step: effect.step,
            networkId: "e".repeat(64),
            containerId: "f".repeat(64),
            imageId: image,
            volumeName: `wrenly-deployment-db-${binding.deploymentId}`,
          };
        case "service-create":
          return {
            step: effect.step,
            serviceId: "service",
            compositionSha256: "1".repeat(64),
            appImageId: image,
            appRegistryDigest: image,
            ingressRegistryDigest: `sha256:${"2".repeat(64)}`,
          };
        case "service-start":
          return { step: effect.step, serviceId: "service" };
        case "application-start":
          return {
            step: effect.step,
            containerId: "3".repeat(64),
            imageId: image,
          };
        case "route-verify":
          return {
            step: effect.step,
            url: "https://app.example.test/",
            sourceSha256: binding.sourceSha256,
          };
      }
    },
  };
  return { services, calls, read: () => journal };
}
test("coordinator runs each confirmed effect once and returns only the verified route", async () => {
  const f = fixture();
  expect(
    await executeProductionRuntimeCoordinator(
      f.services,
      AbortSignal.timeout(1000),
    ),
  ).toBe("https://app.example.test/");
  expect(f.calls).toHaveLength(8);
  expect(f.read().pending).toBeNull();
  expect(
    await executeProductionRuntimeCoordinator(
      f.services,
      AbortSignal.timeout(1000),
    ),
  ).toBe("https://app.example.test/");
  expect(f.calls).toHaveLength(8);
});
test("lost remote acknowledgement preserves intent and refuses another ordinary execution", async () => {
  const f = fixture();
  f.services.perform = async ({ effect }) => {
    f.calls.push(effect.step);
    throw new Error("connection lost");
  };
  await expect(
    executeProductionRuntimeCoordinator(f.services, AbortSignal.timeout(1000)),
  ).rejects.toThrow("saved effect");
  expect(f.read().pending?.step).toBe("http-volume");
  await expect(
    executeProductionRuntimeCoordinator(f.services, AbortSignal.timeout(1000)),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(f.read().completed).toHaveLength(0);
});
test("cancellation after a remote effect never acknowledges it or advances the next effect", async () => {
  const f = fixture(),
    controller = new AbortController(),
    perform = f.services.perform;
  f.services.perform = async (input) => {
    const fact = await perform(input);
    controller.abort();
    return fact;
  };
  await expect(
    executeProductionRuntimeCoordinator(f.services, controller.signal),
  ).rejects.toThrow();
  expect(f.read().pending?.step).toBe("http-volume");
  expect(f.calls).toHaveLength(1);
  expect(f.read().completed).toHaveLength(0);
});

test("a missing saved acknowledgement cannot repeat a remote effect", async () => {
  const f = fixture();
  f.services.acknowledge = async () => {};
  await expect(
    executeProductionRuntimeCoordinator(f.services, AbortSignal.timeout(1000)),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(f.read().pending).not.toBeNull();
});
