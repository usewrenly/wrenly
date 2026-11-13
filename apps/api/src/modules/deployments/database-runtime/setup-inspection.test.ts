import { ProductionRuntimeHostRequest } from "@wrenly/db/production-host-contract";
/** Recovery transport accepts only inspection replies; all provider mutations are absent from this fixture. */
import { expect, test } from "bun:test";
import { inspectProductionSetupEffect } from "./setup-inspection";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
function fixture(index = 0) {
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
    serverId: "fixture-server",
    principal: {
      userId: "owner",
      sessionId: "session",
      revision: crypto.randomUUID(),
      accessRevision: crypto.randomUUID(),
    },
  };
  const token = crypto.randomUUID();
  let journal: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  const facts = [
    {
      step: "http-volume",
      name: `wrenly-deployment-http-${binding.deploymentId}`,
      createdAt: new Date().toISOString(),
    },
    {
      step: "database-volume",
      name: `wrenly-deployment-db-${binding.deploymentId}`,
      createdAt: new Date().toISOString(),
    },
    { step: "broker-network", networkId: "d".repeat(64) },
  ];
  for (let i = 0; i < index; i++) {
    journal = beginProductionPublishingEffect(
      binding,
      journal,
      token,
      new Date(),
    );
    journal = acknowledgeProductionPublishingEffect(
      binding,
      journal,
      {
        effect: journal.pending,
        fact: facts[i],
        completedAt: new Date().toISOString(),
      },
      token,
    );
  }
  journal = beginProductionPublishingEffect(
    binding,
    journal,
    token,
    new Date(),
  );
  return {
    binding,
    journal,
    effect: journal.pending!,
    signal: new AbortController().signal,
    credentials: {
      host: {
        target: {
          host: "host.internal.test",
          port: 22,
          user: "wrenly",
          hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
        },
        addresses: ["10.0.0.1"],
        privateKey: "fixture-only",
      },
    },
    assertHeld: async () => {},
  };
}
test("all three setup stages use fixed read-only actions and preserve original nonce", async () => {
  for (let index = 0; index < 3; index++) {
    const input = fixture(index);
    const requests: string[] = [];
    const fact = await inspectProductionSetupEffect({
      ...input,
      send: async (value) => {
        const request = ProductionRuntimeHostRequest.parse(value.request);
        requests.push(request.action);
        expect(value.request).not.toHaveProperty("runtimeRole");
        expect(request.nonce).toBe(input.effect.id);
        return index === 2
          ? {
              version: 1,
              nonce: input.effect.id,
              dockerId: input.binding.dockerId,
              network: {
                id: "d".repeat(64),
                name: `wrenly-deployment-network-${input.binding.deploymentId}`,
              },
            }
          : {
              version: 1,
              nonce: input.effect.id,
              dockerId: input.binding.dockerId,
              http: {
                name: `wrenly-deployment-http-${input.binding.deploymentId}`,
                createdAt: "fixture-time",
              },
              database: index
                ? {
                    name: `wrenly-deployment-db-${input.binding.deploymentId}`,
                    createdAt: "fixture-time",
                  }
                : null,
            };
      },
    });
    expect(requests).toEqual([
      index === 2 ? "inspect-runtime-network" : "inspect-runtime-volumes",
    ]);
    expect(fact?.step).toBe(input.effect.step);
  }
});
test("absence cannot acknowledge creation; changed daemon, nonce or foreign resource is rejected", async () => {
  const input = fixture();
  const reply = {
    version: 1,
    nonce: input.effect.id,
    dockerId: input.binding.dockerId,
    http: null,
    database: null,
  };
  expect(
    await inspectProductionSetupEffect({ ...input, send: async () => reply }),
  ).toBeNull();
  for (const changed of [
    { ...reply, dockerId: "foreign" },
    { ...reply, nonce: crypto.randomUUID() },
    { ...reply, http: { name: "foreign", createdAt: "fixture" } },
  ])
    await expect(
      inspectProductionSetupEffect({ ...input, send: async () => changed }),
    ).rejects.toThrow();
});
test("changed journal and lost authority prevent inspection and no mutation fallback runs", async () => {
  const input = fixture();
  let calls = 0;
  await expect(
    inspectProductionSetupEffect({
      ...input,
      journal: { ...input.journal, pending: null },
      send: async () => {
        calls++;
        return null;
      },
    }),
  ).rejects.toThrow("changed");
  await expect(
    inspectProductionSetupEffect({
      ...input,
      assertHeld: async () => {
        throw new Error("Lost claim");
      },
      send: async () => {
        calls++;
        return null;
      },
    }),
  ).rejects.toThrow("Lost claim");
  expect(calls).toBe(0);
});
