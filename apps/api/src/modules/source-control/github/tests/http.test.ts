import { expect, test } from "bun:test";
import {
  createGitHubConnectionHandlers,
  type GitHubConnectionService,
} from "../http";
const principal = {
  userId: "owner",
  sessionId: "session",
  revision: crypto.randomUUID(),
};
function fixture(authenticated = true) {
  const calls: string[] = [];
  const service: GitHubConnectionService = {
    status: async () => ({ connected: false }),
    begin: async () => {
      calls.push("start");
      return { kind: "authorization" };
    },
    complete: async () => {
      calls.push("complete");
    },
    disconnect: async () => {
      calls.push("disconnect");
    },
    repositories: async () => ({ repositories: [] }),
  };
  return {
    calls,
    service,
    handlers: createGitHubConnectionHandlers({
      webUrl: "https://instance.example",
      principal: async () => (authenticated ? principal : null),
      service,
    }),
  };
}
function start(
  origin = "https://instance.example",
  body: unknown = { action: "connect" },
): Request {
  return new Request("https://instance.example/api/source/github/start", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("session, trusted origin and strict bounds precede source side effects", async () => {
  const anonymous = fixture(false);
  expect((await anonymous.handlers.start(start())).status).toBe(401);
  expect(anonymous.calls).toEqual([]);
  const f = fixture();
  expect((await f.handlers.start(start("https://evil.example"))).status).toBe(
    403,
  );
  expect(
    (
      await f.handlers.start(
        start(undefined, { action: "connect", userId: "someone-else" }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.handlers.start(
        start(undefined, { action: "register", name: "x".repeat(3000) }),
      )
    ).status,
  ).toBe(400);
  expect(f.calls).toEqual([]);
  expect((await f.handlers.start(start())).status).toBe(200);
  expect(f.calls).toEqual(["start"]);
});
test("callbacks remove codes from the URL and return only a fixed outcome", async () => {
  const f = fixture(),
    state = "s".repeat(43),
    code = "c".repeat(40);
  const response = await f.handlers.authorizationCallback(
    new Request(
      `https://instance.example/api/source/github/authorization/callback?state=${state}&code=${code}`,
    ),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(
    "https://instance.example/settings/connections?github=connected",
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(f.calls).toEqual(["complete"]);
  const duplicate = await f.handlers.authorizationCallback(
    new Request(
      `https://instance.example/callback?state=${state}&state=${state}&code=${code}`,
    ),
  );
  expect(duplicate.headers.get("location")).toEndWith("github=failed");
  expect(f.calls).toEqual(["complete"]);
  f.service.complete = async () => {
    throw new Error("private-provider-response");
  };
  const failed = await f.handlers.authorizationCallback(
    new Request(
      `https://instance.example/callback?state=${state}&code=${code}`,
    ),
  );
  expect(await failed.text()).not.toContain("private-provider-response");
  expect(failed.headers.get("location")).toEndWith("github=failed");
});
