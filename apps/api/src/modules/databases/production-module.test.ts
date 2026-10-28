import { expect, test } from "bun:test";
import type { db } from "@wrenly/db";
import { parseApiEnvironment } from "../../config/api-environment";
import { startProductionDatabaseModule } from "./production-module";
const database = {} as typeof db;
const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: "postgresql://fixture@localhost/unused", WRENLY_AUTH_SECRET: "a".repeat(64),
  WRENLY_APP_URL: "http://localhost:3002", WRENLY_APP_DATABASES_ENABLED: "true", WRENLY_PREVIEW_ENABLED: "true" });
const ingress = new Uint8Array([1]);
test("database host verifies before starting services and joins shutdown exactly once", async () => {
  const events: string[] = [];
  const module = await startProductionDatabaseModule(database, environment, ingress, {
    verify: async () => { events.push("verified"); },
    previews: async () => { events.push("previews"); return { runtime: () => ({ ingressUrl: "http://fixture", capability: "fixture" }), stop: async () => { events.push("preview stopped"); } }; },
    resources: async () => { events.push("resources"); return { stop: async () => { events.push("resources stopped"); } }; },
  });
  expect(events).toEqual(["verified", "previews", "resources"]);
  expect(module.runtime("fixture")?.ingressUrl).toBe("http://fixture");
  await Promise.all([module.stop(), module.stop()]);
  expect(events).toEqual(["verified", "previews", "resources", "preview stopped", "resources stopped"]);
});
test("partial startup and failed shutdown never abandon the other service", async () => {
  let stopped = 0;
  await expect(startProductionDatabaseModule(database, environment, ingress, {
    verify: async () => {}, previews: async () => ({ runtime: () => null, stop: async () => { stopped++; } }),
    resources: async () => { throw new Error("Resource startup failed"); },
  })).rejects.toThrow("Resource startup failed");
  expect(stopped).toBe(1);
  const module = await startProductionDatabaseModule(database, environment, ingress, {
    verify: async () => {}, previews: async () => ({ runtime: () => null, stop: async () => { throw new Error("Uncertain cleanup"); } }),
    resources: async () => ({ stop: async () => { stopped++; } }),
  });
  await expect(module.stop()).rejects.toThrow("cleanup is unconfirmed");
  expect(stopped).toBe(2);
});
test("disabled or invalid hosts start no service", async () => {
  let started = false;
  const adapters = { verify: async () => { throw new Error("Host unavailable"); },
    previews: async () => { started = true; return { runtime: () => null, stop: async () => {} }; },
    resources: async () => { started = true; return { stop: async () => {} }; } };
  await expect(startProductionDatabaseModule(database, { ...environment, WRENLY_APP_DATABASES_ENABLED: "false" }, ingress, adapters)).rejects.toThrow("opt-in");
  await expect(startProductionDatabaseModule(database, environment, ingress, adapters)).rejects.toThrow("Host unavailable");
  expect(started).toBe(false);
});
