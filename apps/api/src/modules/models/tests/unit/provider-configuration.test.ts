import { expect, test } from "bun:test";
import { describeEnvironmentProvider } from "../../environment/environment-providers";
import { normalizeProviderCatalog } from "../../catalog/provider-catalog";
import { createProviderConfigurationService } from "../../configuration/provider-configuration-service";
import { createProviderConfigurationHandlers } from "../../configuration/provider-configuration-http";
import { ProviderConnectionError } from "../../configuration/provider-connection-store";
import { ProviderProbeError } from "../../transport/provider-probe";
function fixture(probeError?: ProviderProbeError) {
  let destinations = 0,
    writes = 0,
    probes = 0,
    environmentReads = 0;
  let savedInput: unknown;
  const environment = describeEnvironmentProvider({
    id: "env",
    label: "Fixture",
    kind: "cloud",
    baseUrl: "https://provider.example/v1",
    displayUrl: "https://provider.example/v1",
    apiKey: "never-browser-token",
  });
  const snapshot = normalizeProviderCatalog({
    compatible: {
      id: "compatible",
      name: "Compatible",
      npm: "@ai-sdk/openai-compatible",
      api: "https://provider.example/v1",
      models: {},
    },
    native: {
      id: "native",
      name: "Native",
      npm: "@ai-sdk/native",
      api: "https://native.example",
      models: {},
    },
  });
  const savedId = crypto.randomUUID();
  const service = createProviderConfigurationService({
    environment: {
      list: () => [environment],
      resolve: () => {
        environmentReads++;
        return { ...environment, token: "never-browser-token" };
      },
    },
    owner: async (actorId) => {
      if (actorId !== "owner")
        throw new ProviderConnectionError(
          403,
          "Only the owner can configure providers.",
        );
    },
    catalog: async () => ({
      snapshot,
      origin: "bundled",
      stale: false,
      cacheUnavailable: false,
    }),
    list: async () => [],
    getDefault: async () => null,
    create: async (_actor, input) => {
      writes++;
      savedInput = input;
      expect(input).toMatchObject({
        endpoint: "https://provider.example/v1",
        protocol: "openai-compatible",
        kind: "cloud",
      });
      return { id: savedId, version: crypto.randomUUID() };
    },
    update: async () => {
      writes++;
    },
    saveDefault: async () => {
      writes++;
    },
    resolve: async (id) => ({
      id,
      version: "fixture",
      label: "Local",
      endpoint: "http://localhost:11434",
      kind: "local",
      protocol: "ollama",
      token: "server-only-token",
    }),
    destination: async () => {
      destinations++;
    },
    probe: async () => {
      probes++;
      if (probeError) throw probeError;
      return { models: [] };
    },
  });
  return {
    service,
    snapshot,
    savedId,
    environment,
    environmentReads: () => environmentReads,
    savedInput: () => savedInput,
    counters: () => ({ destinations, writes, probes }),
  };
}
test("owner authorization precedes destination checks, decryption and writes", async () => {
  const f = fixture();
  await expect(f.service.create("member", {})).rejects.toThrow(
    "Only the owner",
  );
  await expect(f.service.probe("member", { id: f.savedId })).rejects.toThrow(
    "Only the owner",
  );
  await expect(f.service.saveDefault("member", {})).rejects.toThrow(
    "Only the owner",
  );
  expect(f.counters()).toEqual({ destinations: 0, writes: 0, probes: 0 });
});
test("catalog creation binds reviewed version, supported protocol and server-resolved endpoint", async () => {
  const f = fixture();
  const input = {
    source: "catalog",
    requestId: crypto.randomUUID(),
    providerId: "compatible",
    catalogVersion: f.snapshot.version,
    token: "fixture-token",
  };
  await expect(
    f.service.create("owner", { ...input, catalogVersion: "0".repeat(64) }),
  ).rejects.toThrow("catalog changed");
  await expect(
    f.service.create("owner", { ...input, providerId: "native" }),
  ).rejects.toThrow("another protocol");
  await expect(
    f.service.create("owner", {
      ...input,
      endpoint: "https://injected.example/v1",
    }),
  ).rejects.toThrow("valid connection");
  expect(f.counters().writes).toBe(0);
  expect((await f.service.create("owner", input)).id).toBe(f.savedId);
  expect(f.counters()).toEqual({ destinations: 1, writes: 1, probes: 0 });
});
test("read-only probe reports reachable-empty service without exposing its saved token", async () => {
  const f = fixture();
  const result = await f.service.probe("owner", { id: f.savedId });
  expect(result).toEqual({
    connectionId: f.savedId,
    state: "empty",
    models: [],
  });
  expect(JSON.stringify(result)).not.toContain("server-only-token");
});
test("configuration HTTP rejects missing session, wrong origin and oversized/malformed input", async () => {
  const f = fixture();
  let actor: string | null = null;
  const handlers = createProviderConfigurationHandlers({
    webUrl: "http://localhost:3000",
    session: async () => actor,
    service: f.service,
  });
  const request = (body = "{}", origin = "http://localhost:3000"): Request =>
    new Request("http://localhost:3002/api/models/connections", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body,
    });
  expect(
    (await handlers.list(new Request("http://localhost:3002"))).status,
  ).toBe(401);
  expect((await handlers.create(request())).status).toBe(401);
  actor = "owner";
  expect(
    (await handlers.create(request("{}", "http://attacker.test"))).status,
  ).toBe(403);
  expect(
    (await handlers.create(request("x".repeat(16 * 1024 + 1)))).status,
  ).toBe(400);
  expect((await handlers.create(request("{"))).status).toBe(400);
  actor = "member";
  expect(
    (await handlers.list(new Request("http://localhost:3002"))).status,
  ).toBe(403);
  actor = "owner";
  const response = await handlers.list(new Request("http://localhost:3002"));
  expect(await response.json()).toEqual({
    connections: [],
    default: null,
    environment: [f.environment],
  });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("probe authentication failure returns actionable structured metadata without a credential response", async () => {
  const f = fixture(
    new ProviderProbeError("authentication", "Check the token."),
  );
  const result = await f.service.probe("owner", { id: f.savedId });
  expect(result).toEqual({
    connectionId: f.savedId,
    state: "error",
    models: [],
    error: { category: "authentication", message: "Check the token." },
  });
  expect(JSON.stringify(result)).not.toContain("server-only-token");
});

test("environment import binds reviewed destination and reads credentials only after owner authorization", async () => {
  const f = fixture();
  const input = {
    source: "environment",
    envSourceId: "env",
    reviewVersion: f.environment.reviewVersion,
    requestId: crypto.randomUUID(),
  };
  await expect(f.service.create("member", input)).rejects.toThrow(
    "Only the owner",
  );
  expect(f.environmentReads()).toBe(0);
  await expect(
    f.service.create("owner", { ...input, reviewVersion: "0".repeat(64) }),
  ).rejects.toThrow("destination changed");
  await expect(
    f.service.create("owner", {
      ...input,
      endpoint: "https://attacker.example",
    }),
  ).rejects.toThrow("valid connection");
  expect(f.counters().writes).toBe(0);
  await f.service.create("owner", input);
  expect(f.savedInput()).toMatchObject({
    envSourceId: "env",
    token: "never-browser-token",
    endpoint: f.environment.endpoint,
  });
  expect(JSON.stringify(await f.service.list("owner"))).not.toContain(
    "never-browser-token",
  );
});
test("legacy metadata refuses credential-bearing URLs instead of returning them for review", () => {
  expect(() =>
    describeEnvironmentProvider({
      id: "env",
      label: "Fixture",
      kind: "cloud",
      baseUrl: "https://user:secret@provider.example/v1",
      displayUrl: "",
      apiKey: "secret",
    }),
  ).toThrow("credential-free");
});
