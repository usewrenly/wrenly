import { expect, test } from "bun:test";
import { createCatalogHandlers } from "../../catalog/provider-catalog-http";
import { normalizeProviderCatalog } from "../../catalog/provider-catalog";
import { CatalogAccessError } from "../../catalog/provider-catalog-store";
test("authenticated catalog search is paginated, preserves identities and never refreshes implicitly", async () => {
  let actor: string | null = null,
    refreshes = 0;
  const snapshot = normalizeProviderCatalog({
    fixture: {
      id: "fixture",
      name: "Fixture",
      npm: "@ai-sdk/openai-compatible",
      api: "https://provider.example/v1",
      models: {
        one: { id: "one", name: "First" },
        two: { id: "two", name: "Second" },
      },
    },
  });
  const handlers = createCatalogHandlers({
    webUrl: "http://localhost:3000",
    session: async () => actor,
    catalog: async () => ({
      snapshot,
      origin: "bundled",
      stale: true,
      cacheUnavailable: false,
    }),
    refresh: async () => {
      refreshes++;
      return {};
    },
  });
  const request = (query = ""): Request =>
    new Request(`http://localhost:3002/api/models/catalog${query}`);
  expect((await handlers.search(request())).status).toBe(401);
  actor = "member";
  expect((await handlers.search(request("?limit=101"))).status).toBe(400);
  const response = await handlers.search(
    request("?provider=fixture&limit=1&offset=1"),
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  const value = await response.json();
  expect(value.models).toHaveLength(1);
  expect(value.models[0].id).toBe("two");
  expect(value.totalModels).toBe(2);
  expect(value.stale).toBe(true);
  expect(refreshes).toBe(0);
});
test("catalog refresh enforces trusted Origin, session and owner service authorization", async () => {
  const handlers = createCatalogHandlers({
    webUrl: "http://localhost:3000",
    session: async () => "member",
    catalog: async () => {
      throw new Error("unused");
    },
    refresh: async () => {
      throw new CatalogAccessError(403, "Only the instance owner can refresh.");
    },
  });
  const request = (origin: string): Request =>
    new Request("http://localhost:3002/api/models/catalog/refresh", {
      method: "POST",
      headers: { Origin: origin },
    });
  expect((await handlers.refresh(request("http://attacker.test"))).status).toBe(
    403,
  );
  const refusal = await handlers.refresh(request("http://localhost:3000"));
  expect(refusal.status).toBe(403);
  expect(await refusal.text()).toContain("instance owner");
});
