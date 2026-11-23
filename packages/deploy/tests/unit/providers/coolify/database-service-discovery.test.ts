import { expect, test } from "bun:test";
import { discoverDatabaseRuntimeService } from "../../../../src/providers/coolify/database-runtime/discovery";
import { createDatabaseRuntimeComposition } from "../../../../src/providers/coolify/database-runtime/composition";
import type { DeploymentProviderClient } from "../../../../src/http/provider-client";
function fixture() {
  const expected = {
    deploymentId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    framework: "nextjs" as const,
    appImage: `registry.fixture/app@sha256:${"a".repeat(64)}`,
    ingressImage: `registry.fixture/ingress@sha256:${"b".repeat(64)}`,
  };
  const placement = {
    projectUuid: "project",
    serverUuid: "server",
    environmentName: "production",
  };
  const service = {
    uuid: "service",
    name: `wrenly-${expected.deploymentId}`,
    server_id: 2,
    environment_id: 3,
    deleted_at: null,
    docker_compose_raw: createDatabaseRuntimeComposition(expected).document,
    connect_to_docker_network: false,
  };
  const responses: Record<string, unknown> = {
    "/api/v1/projects/project": { id: 1, uuid: "project" },
    "/api/v1/projects/project/production": {
      id: 3,
      project_id: 1,
      name: "production",
    },
    "/api/v1/servers/server": { id: 2, uuid: "server" },
    "/api/v1/services": [service],
    "/api/v1/services/service": service,
  };
  const paths: string[] = [];
  const client: DeploymentProviderClient = {
    request: async (method, path) => {
      expect(method).toBe("GET");
      paths.push(path);
      return responses[path];
    },
  };
  return {
    expected,
    placement,
    service,
    responses,
    paths,
    client,
    signal: new AbortController().signal,
  };
}
test("lost service creation is discovered only after exact placement and composition proof", async () => {
  const input = fixture();
  expect(
    await discoverDatabaseRuntimeService(
      input.client,
      input.expected,
      input.placement,
      input.signal,
    ),
  ).toBe("service");
  expect(input.paths).toContain("/api/v1/projects/project/production");
  expect(
    input.paths.filter((path) => path === "/api/v1/services/service"),
  ).toHaveLength(2);
});
test("absence is separate from refusal; wrappers, ambiguity, foreign placement and modified source cannot acknowledge creation", async () => {
  const empty = fixture();
  empty.responses["/api/v1/services"] = [];
  expect(
    await discoverDatabaseRuntimeService(
      empty.client,
      empty.expected,
      empty.placement,
      empty.signal,
    ),
  ).toBeNull();
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.responses["/api/v1/services"] = { data: [f.service] };
    },
    (f: ReturnType<typeof fixture>) => {
      f.responses["/api/v1/services"] = [
        f.service,
        { ...f.service, uuid: "second" },
      ];
    },
    (f: ReturnType<typeof fixture>) => {
      f.service.server_id = 999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.service.environment_id = 999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.responses["/api/v1/projects/project/production"] = {
        id: 3,
        project_id: 999,
        name: "production",
      };
    },
    (f: ReturnType<typeof fixture>) => {
      f.service.docker_compose_raw = "changed";
    },
  ]) {
    const input = fixture();
    change(input);
    await expect(
      discoverDatabaseRuntimeService(
        input.client,
        input.expected,
        input.placement,
        input.signal,
      ),
    ).rejects.toThrow("No service was created or started");
  }
});
