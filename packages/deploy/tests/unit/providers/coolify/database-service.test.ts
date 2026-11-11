import { expect, test } from "bun:test";
import type { DeploymentProviderClient } from "../../../../src/http/provider-client";
import {
  createDatabaseRuntimeService,
  verifyDatabaseRuntimeService,
  startDatabaseRuntimeService,
} from "../../../../src/providers/coolify/database-runtime/service";
import { createDatabaseRuntimeComposition } from "../../../../src/providers/coolify/database-runtime/composition";
const input = {
  deploymentId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  resourceId: crypto.randomUUID(),
  appImage: `registry.internal.test/wrenly/app@sha256:${"a".repeat(64)}`,
  ingressImage: `registry.internal.test/wrenly/ingress@sha256:${"b".repeat(64)}`,
  framework: "nextjs" as const,
  projectUuid: "project",
  serverUuid: "server",
  environmentName: "production",
};
test("service creation is inert, fixed and never sends runtime secrets", async () => {
  let body: unknown;
  const client: DeploymentProviderClient = {
    request: async (method, path, value) => {
      expect([method, path]).toEqual(["POST", "/api/v1/services"]);
      body = value;
      return { uuid: "service-fixture" };
    },
  };
  expect(
    await createDatabaseRuntimeService(
      client,
      input,
      new AbortController().signal,
    ),
  ).toBe("service-fixture");
  const payload = body as Record<string, unknown>;
  expect(payload.instant_deploy).toBe(false);
  expect(payload.connect_to_docker_network).toBe(false);
  expect(
    Buffer.from(String(payload.docker_compose_raw), "base64").toString(),
  ).toBe(createDatabaseRuntimeComposition(input).document);
  expect(payload.force_domain_override).toBe(false);
});
test("verification never adopts foreign or modified compositions and start is explicit", async () => {
  const good = {
    uuid: "service-fixture",
    name: `wrenly-${input.deploymentId}`,
    docker_compose_raw: createDatabaseRuntimeComposition(input).document,
    connect_to_docker_network: false,
  };
  for (const value of [
    { ...good, uuid: "other" },
    { ...good, docker_compose_raw: "changed" },
    { ...good, connect_to_docker_network: true },
  ])
    await expect(
      verifyDatabaseRuntimeService(
        { request: async () => value },
        "service-fixture",
        input,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  await verifyDatabaseRuntimeService(
    { request: async () => good },
    "service-fixture",
    input,
    new AbortController().signal,
  );
  let mutations = 0;
  await startDatabaseRuntimeService(
    {
      request: async (method, path) => {
        expect([method, path]).toEqual([
          "POST",
          "/api/v1/services/service-fixture/start",
        ]);
        mutations++;
        return { message: "Service starting request queued." };
      },
    },
    "service-fixture",
    new AbortController().signal,
  );
  expect(mutations).toBe(1);
});
