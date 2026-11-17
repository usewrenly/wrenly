/** HTTP acceptance keeps receipt checks read-only and rejects unreviewed owner actions. */
import { expect, test } from "bun:test";
import { createOwnerRuntimeControlHandlers } from "./control-http";
const project = crypto.randomUUID(),
  deployment = crypto.randomUUID(),
  revision = crypto.randomUUID();
const actor = { userId: "owner", sessionId: "owner-session", revision };
const action = {
  requestId: crypto.randomUUID(),
  expectedAccessRevision: revision,
  expectedGrantRevision: null,
  kind: "stop" as const,
  confirmRuntimeControl: true as const,
};
function fixture(options: { anonymous?: boolean; changed?: boolean } = {}) {
  let reads = 0,
    saves = 0,
    checks = 0;
  const handlers = createOwnerRuntimeControlHandlers(
    {
      principal: async () => {
        checks++;
        return options.anonymous || (options.changed && checks > 1)
          ? null
          : actor;
      },
      read: async () => {
        reads++;
        return {
          requestId: action.requestId,
          kind: "stop",
          status: "interrupted",
          step: "application-stop",
          replayed: true,
        };
      },
      save: async () => {
        saves++;
        return {
          requestId: action.requestId,
          kind: "stop",
          status: "success",
          step: null,
          replayed: false,
        };
      },
    },
    "https://wrenly.example",
  );
  return { handlers, counts: () => ({ reads, saves }) };
}
function post(
  body: unknown = action,
  origin = "https://wrenly.example",
): Request {
  return new Request("https://api.example/runtime-controls", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("saved control lookup never repeats host execution", async () => {
  const f = fixture();
  const result = await f.handlers.get(
    new Request("https://api.example/runtime-controls"),
    project,
    deployment,
    action.requestId,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(f.counts()).toEqual({ reads: 1, saves: 0 });
});
test("control requires active identity, trusted origin and a strict bounded confirmation", async () => {
  const f = fixture();
  expect(
    (
      await f.handlers.save(
        post(action, "https://foreign.example"),
        project,
        deployment,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.handlers.save(
        post({ ...action, credentials: "browser-supplied" }),
        project,
        deployment,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.handlers.save(
        post({ ...action, confirmRuntimeControl: false }),
        project,
        deployment,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.handlers.save(
        post({ extra: "x".repeat(3000) }),
        project,
        deployment,
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await fixture({ anonymous: true }).handlers.save(
        post(),
        project,
        deployment,
      )
    ).status,
  ).toBe(401);
  expect(f.counts().saves).toBe(0);
  expect((await f.handlers.save(post(), project, deployment)).status).toBe(200);
  expect(f.counts().saves).toBe(1);
});
test("session loss after an admitted action returns no privileged result", async () => {
  const f = fixture({ changed: true });
  expect((await f.handlers.save(post(), project, deployment)).status).toBe(401);
  expect(f.counts().saves).toBe(1);
});
