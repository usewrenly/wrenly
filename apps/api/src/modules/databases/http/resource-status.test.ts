import { expect, test } from "bun:test";
import { createDatabaseResourceStatusHandler } from "./resource-status";
import { DatabaseResourceStatus } from "@wrenly/db/app-database-resource-contract";

const projectId = crypto.randomUUID();
const resourceId = crypto.randomUUID();
const actorId = crypto.randomUUID();
const url = `http://localhost/api/projects/${projectId}/databases`;
function fixture(): Record<string, unknown> {
  return { capabilities: { manage: false, developmentRows: false, productionRows: false },
    resources: [{ id: resourceId, projectId, environment: "development", provider: "local", status: "ready",
      revision: crypto.randomUUID(), schemaDigest: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }],
    operations: [{ id: crypto.randomUUID(), databaseId: resourceId, kind: "create", status: "success",
      errorCode: null, createdAt: new Date(), completedAt: new Date() }] };
}
test("status reads return bounded private metadata and serialize dates", async () => {
  const handler = createDatabaseResourceStatusHandler({ userId: async () => actorId,
    read: async (project, actor) => { expect(project).toBe(projectId); expect(actor).toBe(actorId); return fixture(); } });
  const response = await handler(new Request(url), projectId);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  const value = DatabaseResourceStatus.parse(await response.json());
  const resource = value.resources[0];
  if (!resource) throw new Error("Expected fixture resource");
  expect(typeof resource.createdAt).toBe("string");
  expect(Object.keys(resource)).not.toContain("secrets");
});
test("authentication, methods and invalid requests cannot reach status storage", async () => {
  let reads = 0;
  const read = async (): Promise<unknown> => { reads++; return fixture(); };
  const denied = createDatabaseResourceStatusHandler({ userId: async () => null, read });
  expect((await denied(new Request(url), projectId)).status).toBe(401);
  const handler = createDatabaseResourceStatusHandler({ userId: async () => actorId, read });
  expect((await handler(new Request(url, { method: "POST" }), projectId)).status).toBe(405);
  expect((await handler(new Request(url + "?environment=production"), projectId)).status).toBe(400);
  expect((await handler(new Request(url), "invalid")).status).toBe(400);
  const controller = new AbortController(); controller.abort();
  expect((await handler(new Request(url, { signal: controller.signal }), projectId)).status).toBe(503);
  expect(reads).toBe(0);
});
test("secret fields, cross-project data and inconsistent status are never returned", async () => {
  const valid = fixture();
  const resources = valid.resources as Array<Record<string, unknown>>;
  for (const value of [
    { ...valid, secrets: "DO_NOT_RETURN" },
    { ...valid, resources: [{ ...resources[0], secrets: "DO_NOT_RETURN" }] },
    { ...valid, resources: [{ ...resources[0], projectId: crypto.randomUUID() }] },
    { ...valid, resources: [resources[0], resources[0]] },
    { ...valid, capabilities: { manage: false, developmentRows: false, productionRows: true } },
    { ...valid, operations: [{ id: crypto.randomUUID(), databaseId: crypto.randomUUID(), kind: "read",
      status: "success", errorCode: null, createdAt: new Date(), completedAt: new Date() }] },
  ]) {
    const handler = createDatabaseResourceStatusHandler({ userId: async () => actorId, read: async () => value });
    const response = await handler(new Request(url), projectId);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("DO_NOT_RETURN");
  }
});
test("expired sessions and service errors return fixed safe messages", async () => {
  let sessions = 0;
  const expired = createDatabaseResourceStatusHandler({ userId: async () => ++sessions === 1 ? actorId : null,
    read: async () => fixture() });
  expect((await expired(new Request(url), projectId)).status).toBe(401);
  for (const status of [403, 404, 500]) {
    const handler = createDatabaseResourceStatusHandler({ userId: async () => actorId,
      read: async () => { throw Object.assign(new Error("PRIVATE_CONNECTION_SECRET"), { status }); } });
    const response = await handler(new Request(url), projectId);
    expect(response.status).toBe(status === 500 ? 503 : status);
    expect(await response.text()).not.toContain("PRIVATE_CONNECTION_SECRET");
  }
});
