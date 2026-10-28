import { expect, test } from "bun:test";
import { createDatabaseRecoveryHandlers } from "./recovery";
const origin = "http://localhost:3000";
const project = crypto.randomUUID(), actor = crypto.randomUUID();
const review = { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(),
  expectedRevision: crypto.randomUUID(), kind: "recover-before-effect", confirmRecovery: true } as const;
const receipt = { operationId: crypto.randomUUID(), resourceId: crypto.randomUUID(), replayed: false };
function request(body: unknown = review, source = origin): Request {
  return new Request(`http://localhost/api/projects/${project}/database-recovery`, {
    method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
test("recovery requires explicit confirmation and exact safe recovery input before dispatch", async () => {
  let calls = 0;
  const handlers = createDatabaseRecoveryHandlers({ userId: async () => actor,
    admit: async (id, user, value) => { expect([id, user]).toEqual([project, actor]);
      expect(value.confirmRecovery).toBe(true); calls++; return receipt; }, lookup: async () => null }, origin);
  for (const invalid of [ { ...review, confirmRecovery: false }, { ...review, confirmRecovery: undefined },
    { ...review, kind: "retry" }, { ...review, sql: "DROP DATABASE app" },
    { ...review, expectedRevision: null }, { ...review, operationId: "latest" } ]) {
    expect((await handlers.submit(request(invalid), project)).status).toBe(400);
  }
  expect((await handlers.submit(request(review, "https://hostile.example"), project)).status).toBe(403);
  expect(calls).toBe(0);
  for (const kind of ["recover-before-effect", "recover-runtime-state", "recover-read", "recover-validation"]) {
    expect((await handlers.submit(request({ ...review, kind }), project)).status).toBe(202);
  }
  expect(calls).toBe(4);
});
test("recovery retains unknown outcomes and receipt lookup cannot execute recovery", async () => {
  let calls = 0;
  const handlers = createDatabaseRecoveryHandlers({ userId: async () => actor,
    admit: async () => { calls++; throw new Error("PRIVATE_DATABASE_PASSWORD"); },
    lookup: async () => ({ ...receipt, replayed: true }) }, origin);
  const result = await handlers.submit(request(), project);
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain("PRIVATE_DATABASE_PASSWORD");
  const saved = await handlers.acknowledgement(new Request("http://localhost/"), project, review.requestId);
  expect(await saved.json()).toEqual({ acknowledgement: { ...receipt, replayed: true } });
  expect(calls).toBe(1);
});
