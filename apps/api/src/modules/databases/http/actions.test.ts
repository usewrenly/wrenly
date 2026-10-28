import { expect, test } from "bun:test";
import { createDatabaseActionHandlers } from "./actions";
import { DATABASE_ACTION_BODY_BYTES } from "./action-input";

const project = crypto.randomUUID(), actor = crypto.randomUUID(), requestId = crypto.randomUUID();
const origin = "http://localhost:3000";
const url = `http://localhost/api/projects/${project}/database-actions`;
const action = { requestId, kind: "create", environment: "development", expectedRevision: null } as const;
const receipt = { operationId: crypto.randomUUID(), resourceId: crypto.randomUUID(), replayed: false };
function request(value: unknown = action, source = origin): Request {
  return new Request(url, { method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(value) });
}
test("explicit actions return admission receipts and saved lookup does not execute work", async () => {
  let admissions = 0;
  const handlers = createDatabaseActionHandlers({ userId: async () => actor,
    admit: async (id, user, value) => { expect(id).toBe(project); expect(user).toBe(actor);
      expect(value).toEqual(action); admissions++; return { ...receipt, replayed: admissions > 1 }; },
    lookup: async (id, user, key) => { expect([id, user, key]).toEqual([project, actor, requestId]); return { ...receipt, replayed: true }; },
  }, origin);
  expect((await handlers.submit(request(), project)).status).toBe(202);
  expect((await handlers.submit(request(), project)).status).toBe(200);
  const saved = await handlers.acknowledgement(new Request(url), project, requestId);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ acknowledgement: { ...receipt, replayed: true } });
  expect(saved.headers.get("cache-control")).toBe("private, no-store");
  expect(admissions).toBe(2);
});
test("bad origin, input, body size and expired session cannot admit work", async () => {
  let admissions = 0;
  let identity: string | null = actor;
  const handlers = createDatabaseActionHandlers({ userId: async () => identity,
    admit: async () => { admissions++; return receipt; }, lookup: async () => null }, origin);
  expect((await handlers.submit(request(action, "https://hostile.example"), project)).status).toBe(403);
  expect((await handlers.submit(request({ ...action, password: "SECRET" }), project)).status).toBe(400);
  expect((await handlers.submit(request({ ...action, kind: "stop" }), project)).status).toBe(400);
  expect((await handlers.submit(request("x".repeat(DATABASE_ACTION_BODY_BYTES)), project)).status).toBe(413);
  expect((await handlers.submit(new Request(url), project)).status).toBe(405);
  expect((await handlers.submit(request(), "bad")).status).toBe(400);
  identity = null;
  expect((await handlers.submit(request(), project)).status).toBe(401);
  expect(admissions).toBe(0);
  let calls = 0;
  const expired = createDatabaseActionHandlers({ userId: async () => ++calls === 1 ? actor : null,
    admit: async () => { admissions++; return receipt; }, lookup: async () => null }, origin);
  expect((await expired.submit(request(), project)).status).toBe(401);
  expect(admissions).toBe(0);
});
test("an admission receipt is not masked by a later session change; unknown failures require lookup", async () => {
  let sessions = 0;
  const known = createDatabaseActionHandlers({ userId: async () => ++sessions <= 2 ? actor : null,
    admit: async () => receipt, lookup: async () => null }, origin);
  expect((await known.submit(request(), project)).status).toBe(202);
  expect(sessions).toBe(2);
  const unknown = createDatabaseActionHandlers({ userId: async () => actor,
    admit: async () => { throw new Error("PRIVATE_PROVIDER_SECRET"); }, lookup: async () => null }, origin);
  const response = await unknown.submit(request(), project);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("PRIVATE_PROVIDER_SECRET");
  expect(await (await unknown.acknowledgement(new Request(url), project, requestId)).json()).toEqual({ acknowledgement: null });
});

test("stalled or cancelled uploads stop before admission", async () => {
  let admissions = 0;
  const handlers = createDatabaseActionHandlers({ userId: async () => actor,
    admit: async () => { admissions++; return receipt; }, lookup: async () => null }, origin);
  const controller = new AbortController();
  const stalled = (): ReadableStream<Uint8Array> => new ReadableStream({ start() {} });
  const timed = await handlers.submit(new Request(url, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: stalled() }), project);
  expect(timed.status).toBe(408);
  const cancelled = handlers.submit(new Request(url, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: stalled(), signal: controller.signal }), project);
  controller.abort();
  expect((await cancelled).status).toBe(503);
  expect(admissions).toBe(0);
}, 10_000);
