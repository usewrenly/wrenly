import { executeProductionServiceEffect } from "./service-adapter";
import {
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import { createDatabaseRuntimeComposition } from "@wrenly/deploy";
import { expect, test } from "bun:test";
import { executeProductionHostEffect } from "./host-adapter";
import {
  beginProductionPublishingEffect,
  type ProductionPublishingBinding,
} from "@wrenly/db/production-publishing-contract";
import type { ProductionPublishingRuntimeSecrets } from "./secrets";
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
  const token = crypto.randomUUID(),
    journal = beginProductionPublishingEffect(
      binding,
      { version: 1, pending: null, completed: [] },
      token,
      new Date(),
    );
  const credentials: ProductionPublishingRuntimeSecrets = {
    host: {
      target: {
        host: "deploy.internal.test",
        port: 22,
        user: "wrenly",
        hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
      },
      addresses: ["10.0.0.1"],
      privateKey: "fixture",
    },
    database: {
      runtimeRole: {
        user: `wrenly_${binding.resourceId.replaceAll("-", "")}_runtime`,
        password: "d".repeat(64),
      },
      upstream: {
        hostname: "db.internal.test",
        address: "10.0.0.2",
        port: 5432,
      },
      addresses: ["10.0.0.2"],
    },
    appKey: null,
  };
  return {
    binding,
    journal,
    effect: journal.pending!,
    signal: AbortSignal.timeout(1000),
    credentials,
    brokerImageId: `sha256:${"e".repeat(64)}`,
  };
}
test("host provisioning binds requests and replies to the persisted effect, without unnecessary database credentials", async () => {
  const input = fixture();
  let request: unknown;
  const result = await executeProductionHostEffect({
    ...input,
    send: async (value) => {
      request = value.request;
      return {
        version: 1,
        nonce: input.effect.id,
        dockerId: input.binding.dockerId,
        http: {
          name: `wrenly-deployment-http-${input.binding.deploymentId}`,
          createdAt: new Date().toISOString(),
        },
        database: null,
      };
    },
  });
  expect(result.step).toBe("http-volume");
  expect(request).toEqual({
    version: 1,
    nonce: input.effect.id,
    expectedDockerId: input.binding.dockerId,
    deploymentId: input.binding.deploymentId,
    projectId: input.binding.projectId,
    resourceId: input.binding.resourceId,
    claimToken: input.effect.claimToken,
    confirmDurableIntent: true,
    action: "create-http-volume",
  });
  expect(JSON.stringify(request)).not.toContain(
    input.credentials.database.runtimeRole.password,
  );
});
test("foreign daemon, stale nonce and foreign volume acknowledgements stay unconfirmed", async () => {
  const input = fixture(),
    reply = {
      version: 1,
      nonce: input.effect.id,
      dockerId: input.binding.dockerId,
      http: {
        name: `wrenly-deployment-http-${input.binding.deploymentId}`,
        createdAt: new Date().toISOString(),
      },
      database: null,
    };
  for (const response of [
    { ...reply, nonce: crypto.randomUUID() },
    { ...reply, dockerId: "foreign" },
    { ...reply, http: { ...reply.http, name: "foreign" } },
    { ...reply, password: "secret" },
  ])
    await expect(
      executeProductionHostEffect({ ...input, send: async () => response }),
    ).rejects.toThrow("could not be confirmed");
});
test("an effect not saved in the journal never reaches SSH", async () => {
  const input = fixture();
  let calls = 0;
  await expect(
    executeProductionHostEffect({
      ...input,
      effect: { ...input.effect, id: crypto.randomUUID() },
      send: async () => {
        calls++;
        return {};
      },
    }),
  ).rejects.toThrow("saved intent");
  expect(calls).toBe(0);
});

test("service effects send only the frozen composition and refuse retargeting before provider calls", async () => {
  const f = fixture(),
    token = f.effect.claimToken,
    imageId = `sha256:${"f".repeat(64)}`;
  let journal: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  const facts = [
    {
      step: "http-volume",
      name: `wrenly-deployment-http-${f.binding.deploymentId}`,
      createdAt: new Date().toISOString(),
    },
    {
      step: "database-volume",
      name: `wrenly-deployment-db-${f.binding.deploymentId}`,
      createdAt: new Date().toISOString(),
    },
    { step: "broker-network", networkId: "a".repeat(64) },
    {
      step: "broker-start",
      containerId: "b".repeat(64),
      imageId,
      networkId: "a".repeat(64),
      volumeName: `wrenly-deployment-db-${f.binding.deploymentId}`,
    },
  ];
  for (const fact of facts) {
    journal = beginProductionPublishingEffect(
      f.binding,
      journal,
      token,
      new Date(),
    );
    journal = acknowledgeProductionPublishingEffect(
      f.binding,
      journal,
      { effect: journal.pending, fact, completedAt: new Date().toISOString() },
      token,
    );
  }
  journal = beginProductionPublishingEffect(
    f.binding,
    journal,
    token,
    new Date(),
  );
  const images = {
    appImageId: imageId,
    appImage: `registry.internal.test/wrenly/app@${imageId}`,
    ingressImage: `registry.internal.test/wrenly/ingress@sha256:${"e".repeat(64)}`,
    framework: "nextjs" as const,
  };
  const placement = {
    projectUuid: "project",
    serverUuid: f.binding.serverId,
    environmentName: "production",
  };
  const document = createDatabaseRuntimeComposition({
    deploymentId: f.binding.deploymentId,
    projectId: f.binding.projectId,
    resourceId: f.binding.resourceId,
    ...images,
  }).document;
  const calls: string[] = [];
  let sent: unknown;
  const client = {
    request: async (
      method: "GET" | "POST" | "PATCH",
      path: string,
      body?: unknown,
    ): Promise<unknown> => {
      calls.push(method + " " + path);
      if (method === "POST" && path === "/api/v1/services") {
        sent = body;
        return { uuid: "service" };
      }
      if (method === "GET")
        return {
          uuid: "service",
          name: `wrenly-${f.binding.deploymentId}`,
          docker_compose_raw: document,
          connect_to_docker_network: false,
        };
      return { message: "Service starting request queued." };
    },
  };
  const receipt = await executeProductionServiceEffect({
    ...f,
    journal,
    effect: journal.pending!,
    client,
    images,
    placement,
  });
  expect(receipt.step).toBe("service-create");
  expect(JSON.stringify(sent)).not.toContain(
    f.credentials.database.runtimeRole.password,
  );
  journal = acknowledgeProductionPublishingEffect(
    f.binding,
    journal,
    {
      effect: journal.pending,
      fact: receipt,
      completedAt: new Date().toISOString(),
    },
    token,
  );
  journal = beginProductionPublishingEffect(
    f.binding,
    journal,
    token,
    new Date(),
  );
  const before = calls.length;
  await expect(
    executeProductionServiceEffect({
      ...f,
      journal,
      effect: journal.pending!,
      client,
      images,
      placement: { ...placement, serverUuid: "foreign" },
    }),
  ).rejects.toThrow("placement");
  expect(calls).toHaveLength(before);
  await expect(
    executeProductionServiceEffect({
      ...f,
      journal,
      effect: journal.pending!,
      client,
      images: {
        ...images,
        appImage: `registry.internal.test/wrenly/app@sha256:${"c".repeat(64)}`,
      },
      placement,
    }),
  ).rejects.toThrow("could not be confirmed");
  expect(calls).toHaveLength(before);
  expect(
    (
      await executeProductionServiceEffect({
        ...f,
        journal,
        effect: journal.pending!,
        client,
        images,
        placement,
      })
    ).step,
  ).toBe("service-start");
  expect(calls.at(-1)).toBe("POST /api/v1/services/service/start");
});
