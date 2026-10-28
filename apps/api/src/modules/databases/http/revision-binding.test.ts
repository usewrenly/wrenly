import { expect, test } from "bun:test";
import { createDatabaseRevisionBindingHandler } from "./revision-binding";
const project = crypto.randomUUID(), actor = crypto.randomUUID();
const input = { buildId: crypto.randomUUID(), resourceId: crypto.randomUUID(), resourceRevision: crypto.randomUUID(), environment: "development" } as const;
const binding = { ...input, version: 1, projectId: project, accessRevision: crypto.randomUUID(), framework: "nextjs",
  migrationOperationId: crypto.randomUUID(), migrationDigest: "a".repeat(64), schemaDigest: "b".repeat(64) };
const request = (): Request => new Request(`http://localhost/binding?${new URLSearchParams(input)}`);
test("compatibility reads require exact bounded selections and return private matching metadata", async () => {
  let calls = 0;
  const handler = createDatabaseRevisionBindingHandler({ userId: async () => actor, read: async (id, user, value) => {
    calls++; expect([id, user, value]).toEqual([project, actor, input]); return binding;
  } });
  const result = await handler(request(), project);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(binding);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  for (const suffix of ["&buildId=" + input.buildId, "&extra=secret"]) {
    expect((await handler(new Request(request().url + suffix), project)).status).toBe(400);
  }
  expect((await handler(new Request(request().url.replace("development", "production")), project)).status).toBe(400);
  expect((await handler(new Request(request().url, { method: "POST" }), project)).status).toBe(405);
  expect(calls).toBe(1);
});
test("cross-project, secret, expired-session and unknown results never reach callers", async () => {
  for (const value of [{ ...binding, projectId: crypto.randomUUID() }, { ...binding, password: "PRIVATE" }]) {
    const handler = createDatabaseRevisionBindingHandler({ userId: async () => actor, read: async () => value });
    const result = await handler(request(), project);
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("PRIVATE");
  }
  let checks = 0;
  const expired = createDatabaseRevisionBindingHandler({ userId: async () => ++checks === 1 ? actor : null, read: async () => binding });
  expect((await expired(request(), project)).status).toBe(401);
  const denied = createDatabaseRevisionBindingHandler({ userId: async () => null, read: async () => { throw new Error("Must not read"); } });
  expect((await denied(request(), project)).status).toBe(401);
});
