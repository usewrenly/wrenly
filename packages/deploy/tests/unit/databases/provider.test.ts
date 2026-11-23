import { expect, test } from "bun:test";
import { resolveDatabaseProvider, type DatabaseProvider } from "../../../src/databases/provider";
import { createCoolifyDatabaseProvider } from "../../../src/providers/coolify/databases/provider";
const signal = new AbortController().signal;
const intent = { resourceId: crypto.randomUUID(), operationId: crypto.randomUUID(), placement: { providerId: "coolify", projectUuid: "project", serverUuid: "server", environmentUuid: "environment", destinationUuid: "destination" } };
function fixture(id: string): DatabaseProvider {
  return { id, createStopped: async () => "resource", inspect: async () => ({ remoteId: "resource", state: "stopped", tlsConfigured: false }), find: async () => null };
}
test("saved provider identity selects exactly one configured adapter", () => {
  const first = fixture("coolify"), other = fixture("another-deployer");
  expect(resolveDatabaseProvider([first, other], "another-deployer")).toBe(other);
  expect(() => resolveDatabaseProvider([first], "another-deployer")).toThrow("unavailable");
  expect(() => resolveDatabaseProvider([first, first], "coolify")).toThrow("ambiguous");
  expect(() => resolveDatabaseProvider([first], "../module")).toThrow("Invalid");
});
test("Coolify translates common intent and exposes no provider connection URLs", async () => {
  const provider = createCoolifyDatabaseProvider({ request: async (method, path) => {
    expect(method).toBe("POST"); expect(path).toBe("/api/v1/databases/postgresql");
    return { uuid: "remote", internal_db_url: "postgres://private@host/app" };
  } });
  expect(await provider.createStopped(intent, { user: `wrenly_${intent.resourceId.replaceAll("-", "")}_admin`, password: "a".repeat(64) }, signal)).toBe("remote");
});
test("wrong or extra placement fields cannot retarget the Coolify adapter", async () => {
  let calls = 0;
  const provider = createCoolifyDatabaseProvider({ request: async () => { calls++; return {}; } });
  for (const placement of [{ ...intent.placement, providerId: "another-deployer" }, { ...intent.placement, endpoint: "https://foreign.example" }]) {
    await expect(provider.createStopped({ ...intent, placement }, { user: "unused", password: "unused" }, signal)).rejects.toThrow("invalid_input");
  }
  expect(calls).toBe(0);
});
