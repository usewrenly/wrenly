import { expect, test } from "bun:test";
import { createSkillHandlers, type SkillHttpServices } from "./skill-http";
import { SkillError } from "./skill-contract";
const ORIGIN = "http://localhost:3000";
const ID = crypto.randomUUID();
function fixture(actor: string | null = "actor"): {
  services: SkillHttpServices;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const record = async (...args: unknown[]): Promise<unknown> => {
    calls.push(args);
    return { saved: true };
  };
  return {
    calls,
    services: {
      userId: async () => actor,
      list: record,
      get: record,
      create: record,
      save: record,
      status: record,
    },
  };
}
function request(body = "{}", origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/skills`, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body,
  });
}
test("skill routes authenticate and enforce exact origin before parsing or storage", async () => {
  const anonymous = fixture(null),
    loggedIn = fixture();
  expect(
    (await createSkillHandlers(anonymous.services, ORIGIN).create(request()))
      .status,
  ).toBe(401);
  expect(
    (
      await createSkillHandlers(loggedIn.services, ORIGIN).save(
        request("{bad", "https://outside.test"),
        ID,
      )
    ).status,
  ).toBe(403);
  expect(anonymous.calls).toHaveLength(0);
  expect(loggedIn.calls).toHaveLength(0);
});
test("skill routes bound streamed JSON without trusting content length", async () => {
  const { services, calls } = fixture();
  const handlers = createSkillHandlers(services, ORIGIN);
  expect(
    (await handlers.create(request("x".repeat(128 * 1024 + 1)))).status,
  ).toBe(400);
  expect((await handlers.create(request("{bad"))).status).toBe(400);
  expect((await handlers.save(request(), "bad-id")).status).toBe(400);
  expect(calls).toHaveLength(0);
});
test("skill routes pass only authenticated identity and return private no-store acknowledgements", async () => {
  const { services, calls } = fixture();
  const handlers = createSkillHandlers(services, ORIGIN);
  const response = await handlers.save(request('{"document":"reviewed"}'), ID);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(calls).toEqual([["actor", ID, { document: "reviewed" }]]);
  expect(
    (await handlers.status(new Request(ORIGIN), ID, crypto.randomUUID()))
      .status,
  ).toBe(200);
});
test("skill errors preserve conflicts without exposing database failures", async () => {
  const { services } = fixture();
  services.create = async () => {
    throw new SkillError(409, "Reload and compare.");
  };
  expect(
    (await createSkillHandlers(services, ORIGIN).create(request())).status,
  ).toBe(409);
  services.create = async () => {
    throw new Error("private query and secret");
  };
  const response = await createSkillHandlers(services, ORIGIN).create(
    request(),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private query");
});
