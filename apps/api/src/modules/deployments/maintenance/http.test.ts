/** Request fixtures verify transport fences; persisted owner authority is tested separately with PostgreSQL. */
import { expect, test } from "bun:test";
import { createMaintenanceHttpHandlers } from "./http";
const project = crypto.randomUUID(),
  deployment = crypto.randomUUID(),
  revision = crypto.randomUUID();
const actor = { userId: "owner", sessionId: "session", revision };
const view = {
  accessRevision: revision,
  grantRevision: null,
  state: "disabled",
  attempt: null,
};
function fixture() {
  let saves = 0,
    reads = 0,
    principals = 0;
  const handlers = createMaintenanceHttpHandlers(
    {
      principal: async () => {
        principals++;
        return actor;
      },
      read: async () => {
        reads++;
        return view;
      },
      save: async (_actor, _project, _deployment, body) => {
        saves++;
        return {
          requestId: body.requestId,
          grantRevision: revision,
          state: body.state,
          replayed: false,
        };
      },
    },
    "https://wrenly.example",
  );
  return { handlers, calls: () => ({ saves, reads, principals }) };
}
const decision = {
  requestId: crypto.randomUUID(),
  expectedAccessRevision: revision,
  expectedGrantRevision: null,
  state: "enabled",
  confirmMaintenance: true,
};
function post(
  body: unknown = decision,
  origin = "https://wrenly.example",
): Request {
  return new Request("https://api.example/maintenance", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("owner read validates public shape without executing a decision", async () => {
  const f = fixture(),
    response = await f.handlers.get(
      new Request("https://api.example/maintenance"),
      project,
      deployment,
    );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(view);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(f.calls()).toEqual({ saves: 0, reads: 1, principals: 2 });
});
test("foreign origin, invalid identity and unbounded body cannot reach a mutation", async () => {
  const f = fixture();
  expect(
    (
      await f.handlers.save(
        post(decision, "https://foreign.example"),
        project,
        deployment,
      )
    ).status,
  ).toBe(403);
  expect((await f.handlers.save(post(), "bad", deployment)).status).toBe(400);
  expect(
    (
      await f.handlers.save(
        post({ ...decision, extra: "x".repeat(3000) }),
        project,
        deployment,
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await f.handlers.save(
        post({ ...decision, confirmMaintenance: false }),
        project,
        deployment,
      )
    ).status,
  ).toBe(400);
  expect(f.calls().saves).toBe(0);
});
test("a changed session cannot expose a result and receipt lookup cannot write", async () => {
  let calls = 0,
    saves = 0;
  const handlers = createMaintenanceHttpHandlers(
    {
      principal: async () =>
        ++calls === 1 ? actor : { ...actor, revision: crypto.randomUUID() },
      read: async () => view,
      save: async () => {
        saves++;
        throw new Error();
      },
    },
    "https://wrenly.example",
  );
  expect(
    (
      await handlers.get(
        new Request("https://api.example/maintenance"),
        project,
        deployment,
      )
    ).status,
  ).toBe(401);
  expect(saves).toBe(0);
  const f = fixture();
  expect(
    (
      await f.handlers.get(
        new Request("https://api.example/maintenance"),
        project,
        deployment,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(503);
  expect(f.calls().saves).toBe(0);
});
test("valid decision returns only bounded receipt fields", async () => {
  const f = fixture(),
    response = await f.handlers.save(post(), project, deployment);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    requestId: decision.requestId,
    grantRevision: revision,
    state: "enabled",
    replayed: false,
  });
  expect(f.calls().saves).toBe(1);
});
