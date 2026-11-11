import { expect, test } from "bun:test";
import { ProductionRuntimeHostRequest } from "@wrenly/db/production-host-contract";
import { createHash } from "node:crypto";
import { createDatabaseRuntimeComposition } from "@wrenly/deploy";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
  type ProductionPublishingReceipt,
} from "@wrenly/db/production-publishing-contract";
import type { z } from "zod";
import type { ProductionPublishingRuntimeSecrets } from "./secrets";
import { verifyProductionRouteEffect } from "./route-adapter";
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
  const image = `sha256:${"d".repeat(64)}`,
    ingressImageId = `sha256:${"2".repeat(64)}`;
  const images = {
    appImageId: image,
    appImage: `registry.internal.test/wrenly/app@${image}`,
    ingressImage: `registry.internal.test/wrenly/ingress@${ingressImageId}`,
    framework: "nextjs" as const,
  };
  const document = createDatabaseRuntimeComposition({
    ...images,
    ...binding,
  }).document;
  const facts: z.infer<typeof ProductionPublishingReceipt>["fact"][] = [
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
    { step: "broker-network", networkId: "e".repeat(64) },
    {
      step: "broker-start",
      networkId: "e".repeat(64),
      containerId: "f".repeat(64),
      imageId: image,
      volumeName: `wrenly-deployment-db-${binding.deploymentId}`,
    },
    {
      step: "service-create",
      serviceId: "service",
      compositionSha256: createHash("sha256").update(document).digest("hex"),
      appImageId: image,
      appRegistryDigest: image,
      ingressRegistryDigest: ingressImageId,
    },
    { step: "service-start", serviceId: "service" },
    { step: "application-start", containerId: "3".repeat(64), imageId: image },
  ];
  let journal: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  const token = crypto.randomUUID();
  for (const fact of facts) {
    journal = beginProductionPublishingEffect(
      binding,
      journal,
      token,
      new Date(),
    );
    journal = acknowledgeProductionPublishingEffect(
      binding,
      journal,
      { effect: journal.pending!, fact, completedAt: new Date().toISOString() },
      token,
    );
  }
  journal = beginProductionPublishingEffect(
    binding,
    journal,
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
        password: "4".repeat(64),
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
  const requests: unknown[] = [];
  const input: Parameters<typeof verifyProductionRouteEffect>[0] = {
    binding,
    journal,
    effect: journal.pending!,
    images,
    ingressImageId,
    credentials,
    signal: AbortSignal.timeout(1000),
    assertHeld: async () => {},
    client: {
      request: async () => ({
        uuid: "service",
        name: `wrenly-${binding.deploymentId}`,
        docker_compose_raw: document,
        connect_to_docker_network: false,
        applications: [
          { name: "application", fqdn: null },
          { name: "ingress", fqdn: "https://fixture.example/" },
        ],
      }),
    },
    send: async (value) => {
      const request = ProductionRuntimeHostRequest.parse(value.request);
      requests.push(request);
      const base = {
        version: 1,
        nonce: journal.pending!.id,
        dockerId: binding.dockerId,
        running: true,
      };
      if (request.action === "inspect-runtime-broker")
        return {
          ...base,
          containerId: "f".repeat(64),
          imageId: image,
          networkId: "e".repeat(64),
          volumeName: `wrenly-deployment-db-${binding.deploymentId}`,
          socketReady: true,
        };
      return {
        ...base,
        containerId:
          request.action === "find-runtime-ingress"
            ? "5".repeat(64)
            : "3".repeat(64),
        imageId:
          request.action === "find-runtime-ingress" ? ingressImageId : image,
      };
    },
    ready: async () => true,
  };
  return { input, requests };
}
test("route acknowledgement requires host proofs and exact deployment readiness without sending database credentials", async () => {
  const { input, requests } = fixture();
  let probes = 0;
  input.ready = async (url, id) => {
    expect(url).toBe("https://fixture.example/");
    expect(id).toBe(input.binding.deploymentId);
    probes++;
    return true;
  };
  expect(await verifyProductionRouteEffect(input)).toEqual({
    step: "route-verify",
    url: "https://fixture.example/",
    sourceSha256: input.binding.sourceSha256,
  });
  expect(probes).toBe(1);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests)).not.toContain(
    input.credentials.database.runtimeRole.password,
  );
});
test("not-ready HTTP remains pending and changed host proof refuses a route", async () => {
  const { input } = fixture();
  input.ready = async () => false;
  expect(await verifyProductionRouteEffect(input)).toBeNull();
  expect(input.journal.pending?.step).toBe("route-verify");
  const send = input.send!;
  input.send = async (value) => ({
    ...((await send(value)) as object),
    nonce: crypto.randomUUID(),
  });
  await expect(verifyProductionRouteEffect(input)).rejects.toThrow(
    "could not be confirmed",
  );
});
test("changed image or expired ownership refuses route work", async () => {
  const { input, requests } = fixture();
  await expect(
    verifyProductionRouteEffect({
      ...input,
      images: { ...input.images, appImageId: `sha256:${"9".repeat(64)}` },
    }),
  ).rejects.toThrow("intent or images changed");
  await expect(
    verifyProductionRouteEffect({
      ...input,
      assertHeld: async () => {
        throw new Error("expired");
      },
    }),
  ).rejects.toThrow("could not be confirmed");
  expect(requests).toHaveLength(0);
});
