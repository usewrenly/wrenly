import { expect, test } from "bun:test";
import { createInvitationHandlers } from "../../invitations/invitation-http";
import { InvitationError } from "../../invitations/invitation-store";
const request = (body = "{}", origin = "http://localhost:3000"): Request =>
  new Request("http://localhost:3002/api/instance/invitations", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body,
  });
test("invitation administration needs sessions while acceptance remains possession-gated and bounded", async () => {
  let actor: string | null = null;
  const calls: string[] = [];
  const handlers = createInvitationHandlers({
    webUrl: "http://localhost:3000",
    session: async () => actor,
    list: async (id) => {
      calls.push(id);
      return { members: [] };
    },
    initialize: async (id) => {
      calls.push(id);
    },
    issue: async (id) => {
      calls.push(id);
      return { id: "fixture" };
    },
    revoke: async (id) => {
      calls.push(id);
    },
    inspect: async () => {
      calls.push("inspect");
      return { email: "invited@example.test" };
    },
    accept: async () => {
      calls.push("accept");
      return { accountCreated: true };
    },
  });
  expect(
    (await handlers.list(new Request("http://localhost:3002"))).status,
  ).toBe(401);
  expect((await handlers.issue(request())).status).toBe(401);
  expect(
    (await handlers.accept(request("{}", "http://attacker.test"))).status,
  ).toBe(403);
  expect((await handlers.inspect(request("x".repeat(8193)))).status).toBe(400);
  expect((await handlers.accept(request("{"))).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await handlers.inspect(request())).status).toBe(200);
  actor = "owner";
  expect((await handlers.issue(request())).status).toBe(200);
  expect(calls).toEqual(["inspect", "owner"]);
});
test("invitation authorization refusals and service failures are safe and not cached", async () => {
  const handlers = createInvitationHandlers({
    webUrl: "http://localhost:3000",
    session: async () => "member",
    list: async () => {
      throw new InvitationError(
        403,
        "Only the instance owner can manage invitations.",
      );
    },
    initialize: async () => {
      throw new Error("private");
    },
    issue: async () => {
      throw new Error("private");
    },
    revoke: async () => {
      throw new Error("private");
    },
    inspect: async () => {
      throw new InvitationError(403, "Invalid invitation.");
    },
    accept: async () => {
      throw new InvitationError(401, "Sign in to the invited account.");
    },
  });
  const response = await handlers.list(new Request("http://localhost:3002"));
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const failure = await handlers.issue(request());
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("private");
  expect((await handlers.accept(request())).status).toBe(401);
});
