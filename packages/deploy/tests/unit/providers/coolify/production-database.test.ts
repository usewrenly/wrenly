import { expect, test } from "bun:test";
import type { DeploymentProviderClient } from "../../../../src/http/provider-client";
import { createPrivateProductionDatabase } from "../../../../src/providers/coolify/databases/creation";
import { readPrivateProductionDatabase, findPrivateProductionDatabase } from "../../../../src/providers/coolify/databases/inspection";
import { databaseName, databaseMarker, databaseAdministrator } from "../../../../src/providers/coolify/databases/contract";
const intent = { resourceId: crypto.randomUUID(), operationId: crypto.randomUUID(), projectUuid: "project", serverUuid: "server", environmentUuid: "environment", destinationUuid: "destination" };
const signal = new AbortController().signal;
function remote(): Record<string, unknown> {
  return { uuid: "remote", name: databaseName(intent), description: databaseMarker(intent), database_type: "standalone-postgresql", image: "postgres:17-alpine", postgres_user: databaseAdministrator(intent), postgres_db: "app", is_public: false, public_port: null, ports_mappings: null, status: "exited:unhealthy", enable_ssl: false, destination: { uuid: "destination", server: { uuid: "server" } }, postgres_password: "private", internal_db_url: "postgres://private@database/app" };
}
test("creation is private and stopped, with exact resource-bound identity and no response secrets", async () => {
  const calls: string[] = [];
  const client: DeploymentProviderClient = { request: async (method, path, body) => {
    calls.push(`${method} ${path}`);
    expect(body).toMatchObject({ name: databaseName(intent), description: databaseMarker(intent), postgres_user: databaseAdministrator(intent), postgres_password: "a".repeat(64), postgres_db: "app", is_public: false, instant_deploy: false, image: "postgres:17-alpine", limits_memory: "2048m", limits_cpus: "2", destination_uuid: "destination", environment_uuid: "environment" });
    expect(body).not.toHaveProperty("public_port");
    return { uuid: "remote", internal_db_url: "postgres://private@database/app" };
  } };
  expect(await createPrivateProductionDatabase(client, intent, { user: databaseAdministrator(intent), password: "a".repeat(64) }, signal)).toBe("remote");
  expect(calls).toEqual(["POST /api/v1/databases/postgresql"]);
});
test("malformed credentials and identities are rejected before provider access", async () => {
  let calls = 0;
  const client: DeploymentProviderClient = { request: async () => { calls++; return {}; } };
  await expect(createPrivateProductionDatabase(client, intent, { user: "postgres", password: "a".repeat(64) }, signal)).rejects.toThrow("invalid_input");
  await expect(createPrivateProductionDatabase(client, { ...intent, resourceId: "../unsafe" }, { user: "postgres", password: "private" }, signal)).rejects.toThrow("invalid_input");
  expect(calls).toBe(0);
});
test("unknown create responses are never retried and do not expose provider errors", async () => {
  for (const reply of [async () => { throw new Error("private provider body"); }, async () => ({ internal_db_url: "private" })]) {
    let calls = 0;
    const client: DeploymentProviderClient = { request: async () => { calls++; return reply(); } };
    await expect(createPrivateProductionDatabase(client, intent, { user: databaseAdministrator(intent), password: "a".repeat(64) }, signal)).rejects.toThrow("unconfirmed");
    expect(calls).toBe(1);
  }
});
test("inspection returns only safe facts and refuses public, moved or substituted resources", async () => {
  const client: DeploymentProviderClient = { request: async () => remote() };
  expect(await readPrivateProductionDatabase(client, "remote", intent, signal)).toEqual({ uuid: "remote", name: databaseName(intent), status: "exited:unhealthy", sslEnabled: false });
  for (const change of [{ uuid: "other" }, { description: "other" }, { is_public: true }, { public_port: 5432 }, { ports_mappings: "5432:5432" }, { image: "postgres:18-alpine" }, { database_type: "standalone-mysql" }, { destination: { uuid: "other", server: { uuid: "server" } } }, { destination: { uuid: "destination", server: { uuid: "other" } } }]) {
    await expect(readPrivateProductionDatabase({ request: async () => ({ ...remote(), ...change }) }, "remote", intent, signal)).rejects.toThrow("identity_mismatch");
  }
});
test("uncertain creation recovery only lists and inspects, never creates or starts", async () => {
  const calls: string[] = [];
  const client: DeploymentProviderClient = { request: async (method, path) => { calls.push(`${method} ${path}`); return path === "/api/v1/projects/project" ? { uuid: "project" } : path === "/api/v1/databases" ? [remote()] : remote(); } };
  expect((await findPrivateProductionDatabase(client, intent, signal))?.uuid).toBe("remote");
  expect(calls).toEqual(["GET /api/v1/projects/project", "GET /api/v1/databases", "GET /api/v1/databases/remote"]);
  expect(await findPrivateProductionDatabase({ request: async (_, path) => path === "/api/v1/projects/project" ? { uuid: "project" } : [] }, intent, signal)).toBeNull();
});
test("incomplete, ambiguous and colliding recovery lists fail closed", async () => {
  for (const rows of [{ data: [remote()] }, [remote(), remote()], [{ ...remote(), description: "unrelated" }], [{ ...remote(), name: "unrelated" }], [{}], Array.from({ length: 257 }, remote)]) {
    await expect(findPrivateProductionDatabase({ request: async (_, path) => path === "/api/v1/projects/project" ? { uuid: "project" } : rows }, intent, signal)).rejects.toThrow();
  }
});
test("cancellation prevents provider calls", async () => {
  let calls = 0;
  const client: DeploymentProviderClient = { request: async () => { calls++; return remote(); } };
  await expect(createPrivateProductionDatabase(client, intent, { user: databaseAdministrator(intent), password: "a".repeat(64) }, AbortSignal.abort())).rejects.toThrow("unconfirmed");
  await expect(findPrivateProductionDatabase(client, intent, AbortSignal.abort())).rejects.toThrow("unconfirmed");
  expect(calls).toBe(0);
});

test("an inaccessible pinned project cannot be interpreted as an absent database", async () => {
  const calls: string[] = [];
  await expect(findPrivateProductionDatabase({ request: async (_, path) => { calls.push(path); return {}; } }, intent, signal)).rejects.toThrow("unconfirmed");
  expect(calls).toEqual(["/api/v1/projects/project"]);
});
