import { expect, test } from "bun:test";
import snapshot from "../../catalog/provider-catalog-snapshot.json";
import {
  normalizeProviderCatalog,
  validateCatalogSnapshot,
  fetchProviderCatalog,
  CATALOG_URL,
  MAX_CATALOG_BYTES,
} from "../../catalog/provider-catalog";
const fixture = (): Record<string, unknown> => ({
  compatible: {
    id: "compatible",
    name: "Compatible",
    npm: "@ai-sdk/openai-compatible",
    api: "https://provider.example/v1",
    doc: "https://provider.example/docs#models",
    models: {
      "served-model": {
        id: "served-model",
        name: "Served model",
        canonical_model_id: "lab/canonical-model",
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 1, output: 2 },
      },
    },
  },
  native: {
    id: "native",
    name: "Native",
    npm: "@ai-sdk/native-protocol",
    api: "https://native.example/v1",
    models: {},
  },
  templated: {
    id: "templated",
    name: "Templated",
    npm: "@ai-sdk/openai-compatible",
    api: "${SERVICE_BASE_URL}/v1",
    models: {},
  },
});
test("catalog preserves served identities, missing capability data and protocol boundaries without evaluating endpoint templates", () => {
  const normalized = normalizeProviderCatalog(
    fixture(),
    new Date("2026-10-16T00:00:00Z"),
  );
  expect(normalized.providers[0]?.compatibility).toBe("openai-compatible");
  expect(normalized.providers[0]?.documentationUrl).toContain("#models");
  expect(normalized.providers[0]?.models[0]).toMatchObject({
    id: "served-model",
    canonicalId: "lab/canonical-model",
    structuredOutput: null,
  });
  expect(normalized.providers[1]?.compatibility).toBe("adapter-required");
  expect(normalized.providers[2]).toMatchObject({
    endpoint: null,
    compatibility: "endpoint-required",
  });
  expect(validateCatalogSnapshot(normalized).version).toBe(normalized.version);
  expect(
    normalizeProviderCatalog(fixture(), new Date("2026-10-17T00:00:00Z"))
      .version,
  ).toBe(normalized.version);
});
test("catalog rejects invalid identities, unsafe URLs, excessive provider counts and tampered caches", () => {
  expect(() =>
    normalizeProviderCatalog({
      bad: { id: "different", name: "Bad", models: {} },
    }),
  ).toThrow("invalid provider");
  expect(() =>
    normalizeProviderCatalog({
      bad: {
        id: "bad",
        name: "Bad",
        api: "https://user:secret@example.test/v1",
        models: {},
      },
    }),
  ).toThrow("invalid provider");
  expect(() =>
    normalizeProviderCatalog({
      bad: { id: "bad", name: "Bad", doc: "javascript:alert(1)", models: {} },
    }),
  ).toThrow("invalid provider");
  expect(() =>
    normalizeProviderCatalog(
      Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [String(index), {}]),
      ),
    ),
  ).toThrow("count");
  const tampered = normalizeProviderCatalog(fixture());
  tampered.providers[0]!.endpoint = "https://changed.example/v1";
  expect(() => validateCatalogSnapshot(tampered)).toThrow("integrity");
  expect(() => validateCatalogSnapshot({})).toThrow("invalid");
});
test("bundled public snapshot validates for offline use and has bounded metadata", () => {
  const bundled = validateCatalogSnapshot(snapshot);
  expect(bundled.source).toBe(CATALOG_URL);
  expect(bundled.providers.length).toBeGreaterThan(1);
  expect(
    bundled.providers.every((provider) =>
      provider.models.every((model) => typeof model.id === "string"),
    ),
  ).toBe(true);
});
test("registry fetch sends no authorization, refuses redirects and replaces nothing on malformed/oversized responses", async () => {
  const fetcher = async (
    url: unknown,
    options?: RequestInit,
  ): Promise<Response> => {
    expect(url).toBe(CATALOG_URL);
    expect(options?.redirect).toBe("error");
    expect(options?.credentials).toBe("omit");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(fixture());
  };
  expect((await fetchProviderCatalog(fetcher)).providers).toHaveLength(3);
  await expect(
    fetchProviderCatalog(
      async () =>
        new Response("{}", {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(MAX_CATALOG_BYTES + 1),
          },
        }),
    ),
  ).rejects.toThrow("unchanged");
  await expect(
    fetchProviderCatalog(
      async () =>
        new Response("not json", {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  ).rejects.toThrow("unchanged");
  await expect(
    fetchProviderCatalog(async () =>
      Response.redirect("https://other.example/api.json"),
    ),
  ).rejects.toThrow("unchanged");
  await expect(
    fetchProviderCatalog(async () => {
      throw new Error("private transport details");
    }),
  ).rejects.toThrow("unchanged");
});
