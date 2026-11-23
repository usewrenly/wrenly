import { createHash } from "node:crypto";
import { createDatabaseRuntimeComposition } from "@wrenly/deploy";
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
  const composition = createDatabaseRuntimeComposition({
    deploymentId: binding.deploymentId,
    projectId: binding.projectId,
    resourceId: binding.resourceId,
    appImage: `registry.internal/app@sha256:${"e".repeat(64)}`,
    ingressImage: `registry.internal/ingress@sha256:${"f".repeat(64)}`,
    framework: "nextjs",
  });
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
    {
      step: "broker-start",
      containerId: "a".repeat(64),
      imageId: `sha256:${"b".repeat(64)}`,
      networkId: "d".repeat(64),
      volumeName: `wrenly-deployment-db-${binding.deploymentId}`,
    },
    {
      step: "service-create",
      serviceId: "fixture-service",
      compositionSha256: createHash("sha256")
        .update(composition.document)
        .digest("hex"),
      appImageId: `sha256:${"c".repeat(64)}`,
      appRegistryDigest: `sha256:${"e".repeat(64)}`,
      ingressRegistryDigest: `sha256:${"f".repeat(64)}`,
    },
    { step: "service-start", serviceId: "fixture-service" },
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

test("lost broker/service/app starts use only read-only proofs and never send database settings", async () => {
  for (const index of [3, 5, 6]) {
    const input = fixture(index);
    const actions: string[] = [];
    const images = {
      framework: "nextjs" as const,
      appImageId: `sha256:${"c".repeat(64)}`,
      appImage: `registry.internal/app@sha256:${"e".repeat(64)}`,
      ingressImage: `registry.internal/ingress@sha256:${"f".repeat(64)}`,
    };
    const runtime = {
      images,
      placement: {
        projectUuid: "fixture-project",
        serverUuid: input.binding.serverId,
        environmentName: "production",
      },
      brokerImageId: `sha256:${"b".repeat(64)}`,
      ingressImageId: `sha256:${"f".repeat(64)}`,
      upstream: {
        hostname: "db.internal.test",
        address: "10.0.0.2",
        port: 5432,
      },
      client: {
        request: async (method: string) => {
          expect(method).toBe("GET");
          return {
            uuid: "fixture-service",
            name: `wrenly-${input.binding.deploymentId}`,
            docker_compose_raw: createDatabaseRuntimeComposition({
              deploymentId: input.binding.deploymentId,
              projectId: input.binding.projectId,
              resourceId: input.binding.resourceId,
              ...images,
            }).document,
            connect_to_docker_network: false,
          };
        },
      },
    };
    const send: NonNullable<
      Parameters<typeof inspectProductionSetupEffect>[0]["send"]
    > = async ({ request }) => {
      expect(request).not.toHaveProperty("runtimeRole");
      const checked = ProductionRuntimeHostRequest.parse(request);
      actions.push(checked.action);
      expect(checked.nonce).toBe(input.effect.id);
      if (checked.action === "find-runtime-broker")
        return {
          version: 1,
          nonce: input.effect.id,
          dockerId: input.binding.dockerId,
          containerId: "a".repeat(64),
          imageId: runtime.brokerImageId,
          networkId: "d".repeat(64),
          volumeName: `wrenly-deployment-db-${input.binding.deploymentId}`,
          running: true,
          socketReady: true,
        };
      if (
        checked.action !== "find-runtime-application" &&
        checked.action !== "find-runtime-ingress" &&
        checked.action !== "verify-runtime-application-ready"
      )
        throw new Error("Mutation forbidden");
      return {
        version: 1,
        nonce: input.effect.id,
        dockerId: input.binding.dockerId,
        containerId: "a".repeat(64),
        imageId: checked.imageId,
        running: true,
        ...(checked.action === "verify-runtime-application-ready"
          ? { ready: true }
          : {}),
      };
    };
    const result = await inspectProductionSetupEffect({
      ...input,
      runtime,
      send,
    });
    expect(result?.step).toBe(input.effect.step);
    expect(actions).toEqual(
      index === 3
        ? ["find-runtime-broker"]
        : index === 5
          ? ["find-runtime-application", "find-runtime-ingress"]
          : ["find-runtime-application", "verify-runtime-application-ready"],
    );
    await expect(
      inspectProductionSetupEffect({
        ...input,
        runtime,
        send: async (request) => {
          const reply = (await send(request)) as Record<string, unknown>;
          return {
            ...reply,
            ...(index === 3 ? { socketReady: false } : { running: false }),
          };
        },
      }),
    ).rejects.toThrow();
    if (index === 6)
      await expect(
        inspectProductionSetupEffect({
          ...input,
          runtime,
          send: async (request) => {
            const reply = (await send(request)) as Record<string, unknown>;
            if (
              ProductionRuntimeHostRequest.parse(request.request).action ===
              "verify-runtime-application-ready"
            )
              delete reply.ready;
            return reply;
          },
        }),
      ).rejects.toThrow();
  }
});

test("lost service receipt requires pinned provider discovery and never contacts the host", async () => {
  const input = fixture(4);
  const images = {
    framework: "nextjs" as const,
    appImageId: `sha256:${"c".repeat(64)}`,
    appImage: `registry.internal/app@sha256:${"e".repeat(64)}`,
    ingressImage: `registry.internal/ingress@sha256:${"f".repeat(64)}`,
  };
  const service = {
    uuid: "fixture-service",
    name: `wrenly-${input.binding.deploymentId}`,
    server_id: 2,
    environment_id: 3,
    deleted_at: null,
    connect_to_docker_network: false,
    docker_compose_raw: createDatabaseRuntimeComposition({
      ...images,
      deploymentId: input.binding.deploymentId,
      projectId: input.binding.projectId,
      resourceId: input.binding.resourceId,
    }).document,
  };
  const responses: Record<string, unknown> = {
    "/api/v1/projects/project": { id: 1, uuid: "project" },
    "/api/v1/projects/project/production": {
      id: 3,
      project_id: 1,
      name: "production",
    },
    [`/api/v1/servers/${input.binding.serverId}`]: {
      id: 2,
      uuid: input.binding.serverId,
    },
    "/api/v1/services": [service],
    "/api/v1/services/fixture-service": service,
  };
  const result = await inspectProductionSetupEffect({
    ...input,
    runtime: {
      images,
      placement: {
        projectUuid: "project",
        serverUuid: input.binding.serverId,
        environmentName: "production",
      },
      brokerImageId: `sha256:${"b".repeat(64)}`,
      ingressImageId: `sha256:${"f".repeat(64)}`,
      upstream: {
        hostname: "db.internal.test",
        address: "10.0.0.2",
        port: 5432,
      },
      client: {
        request: async (method, path) => {
          expect(method).toBe("GET");
          return responses[path];
        },
      },
    },
    send: async () => {
      throw new Error("Unexpected host operation");
    },
  });
  expect(result?.step).toBe("service-create");
  expect(result).toHaveProperty("serviceId", "fixture-service");
});

test("continuation independently reinspects earlier receipts and stops immediately on changed proof", async () => {
  const { inspectCompletedProductionEffects } =
    await import("./inspect-completed");
  const input = fixture(6);
  const fact = {
    step: "application-start",
    containerId: "a".repeat(64),
    imageId: `sha256:${"c".repeat(64)}`,
  };
  const journal = acknowledgeProductionPublishingEffect(
    input.binding,
    input.journal,
    { effect: input.effect, fact, completedAt: new Date().toISOString() },
    input.effect.claimToken,
  );
  const snapshot = JSON.stringify(journal);
  const steps: string[] = [];
  await inspectCompletedProductionEffects(
    { ...input, journal },
    async (selected) => {
      steps.push(selected.effect.step);
      return journal.completed.find(
        (receipt) => receipt.effect.id === selected.effect.id,
      )!.fact;
    },
  );
  expect(steps).toEqual([
    "http-volume",
    "database-volume",
    "broker-start",
    "service-create",
    "service-start",
    "application-start",
  ]);
  expect(JSON.stringify(journal)).toBe(snapshot);
  let reads = 0;
  await expect(
    inspectCompletedProductionEffects({ ...input, journal }, async () => {
      reads++;
      return null;
    }),
  ).rejects.toThrow("No later effect");
  expect(reads).toBe(1);
  await expect(inspectCompletedProductionEffects(input)).rejects.toThrow(
    "unresolved original effect",
  );
});
