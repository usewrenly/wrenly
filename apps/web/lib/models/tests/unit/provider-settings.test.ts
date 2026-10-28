import { expect, test } from "bun:test";
import {
  parseProviderSettings,
  parseConnectionProbe,
  parseCatalogResult,
} from "../../provider-settings";

test("browser metadata projection discards credentials and rejects incomplete connection state", () => {
  const connection = {
    id: "connection",
    version: "version",
    label: "Local",
    protocol: "ollama",
    kind: "local",
    endpoint: "http://localhost:11434",
    enabled: true,
    catalogProviderId: null,
    tokenConfigured: false,
    token: "must-not-be-retained",
    credential: "ciphertext",
  };
  const parsed = parseProviderSettings({
    connections: [connection],
    default: { connectionId: "connection", modelId: "local-model" },
  });
  expect(JSON.stringify(parsed)).not.toContain("must-not-be-retained");
  expect(parsed.connections[0]).not.toHaveProperty("credential");
  expect(() =>
    parseProviderSettings({
      connections: [{ ...connection, enabled: "true" }],
      default: null,
    }),
  ).toThrow();
});

test("empty discovery stays distinct from errors and catalog parsing requires source metadata", () => {
  expect(parseConnectionProbe({ state: "empty", models: [] })).toEqual({
    state: "empty",
    models: [],
  });
  expect(
    parseConnectionProbe({
      state: "error",
      models: [],
      error: { message: "Start the service." },
    }).error?.message,
  ).toBe("Start the service.");
  expect(() =>
    parseConnectionProbe({ state: "ready", models: [42] }),
  ).toThrow();
  expect(() =>
    parseCatalogResult({
      providers: [],
      models: [],
      totalProviders: 0,
      totalModels: 0,
      stale: false,
      version: "x",
      fetchedAt: "now",
    }),
  ).toThrow();
});
