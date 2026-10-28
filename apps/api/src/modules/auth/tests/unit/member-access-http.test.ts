// HTTP policy is independent of database authorization.
import { expect, test } from "bun:test";
import { createMemberAccessHandlers } from "../../members/member-access-http";
import { MemberAccessError } from "../../members/member-access-store";
test("member management authenticates, validates origin, bounds input and separates reconciliation", async () => {
  const calls: string[] = [];
  const handlers = createMemberAccessHandlers({
    webUrl: "http://localhost:3000",
    session: async (headers) => (headers.get("cookie") ? "owner" : null),
    change: async (_actor, _headers, input) => {
      calls.push("change");
      return input;
    },
    status: async () => {
      calls.push("status");
      return { action: null };
    },
  });
  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost:3002/api/instance/access/actions", {
      method: "POST",
      headers: {
        Cookie: "fixture",
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        ...headers,
      },
      body,
    });
  expect((await handlers.change(request("{}", { Cookie: "" }))).status).toBe(
    401,
  );
  expect(
    (
      await handlers.change(
        request("{}", { Origin: "https://outside.invalid" }),
      )
    ).status,
  ).toBe(403);
  expect((await handlers.change(request("{}", { Origin: "" }))).status).toBe(
    403,
  );
  expect((await handlers.change(request("x".repeat(5000)))).status).toBe(400);
  expect((await handlers.change(request("{"))).status).toBe(400);
  expect(calls).toEqual([]);
  expect(
    (
      await handlers.status(
        new Request(
          "http://localhost:3002/api/instance/access/actions/fixture",
          { headers: { Cookie: "fixture" } },
        ),
        "fixture",
      )
    ).status,
  ).toBe(200);
  expect(calls).toEqual(["status"]);
  expect((await handlers.change(request("{}"))).status).toBe(200);
});
test("non-owner and blocker failures preserve explicit service status", async () => {
  const handlers = createMemberAccessHandlers({
    webUrl: "http://localhost:3000",
    session: async () => "member",
    change: async () => {
      throw new MemberAccessError(
        403,
        "Only the instance owner can manage access.",
      );
    },
    status: async () => {
      throw new MemberAccessError(409, "Review access again.");
    },
  });
  expect(
    (
      await handlers.change(
        new Request("http://localhost:3002/api/instance/access/actions", {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handlers.status(
        new Request(
          "http://localhost:3002/api/instance/access/actions/fixture",
        ),
        "fixture",
      )
    ).status,
  ).toBe(409);
});
