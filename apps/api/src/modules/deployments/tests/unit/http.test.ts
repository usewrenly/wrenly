import { expect, test } from "bun:test";
import { createDeploymentHttpHandlers } from "../../http/http";
const project = crypto.randomUUID();
const build = crypto.randomUUID();
const id = crypto.randomUUID();
const key = crypto.randomUUID();
test("publishing requires explicit revision, stable identity and authentication before admission", async () => {
  let calls = 0;
  const handlers = createDeploymentHttpHandlers({
    enabled: true,
    userId: async () => "owner",
    admit: async (projectId, userId, buildId, requestKey) => {
      calls++;
      expect([projectId, userId, buildId, requestKey]).toEqual([
        project,
        "owner",
        build,
        key,
      ]);
      return { deploymentId: id, replayed: calls > 1 };
    },
    get: async () => null,
  });
  const request = (body: string, requestKey: string = key): Request =>
    new Request("http://api.test", {
      method: "POST",
      headers: { "Idempotency-Key": requestKey },
      body,
    });
  for (const body of [
    "{}",
    "{",
    JSON.stringify({ buildId: "latest" }),
    JSON.stringify({ buildId: build, extra: true }),
  ])
    expect((await handlers.create(request(body), project)).status).toBe(400);
  expect(
    (
      await handlers.create(
        request(JSON.stringify({ buildId: build }), ""),
        project,
      )
    ).status,
  ).toBe(400);
  expect(
    (await handlers.create(request("x".repeat(1025)), project)).status,
  ).toBe(413);
  expect(calls).toBe(0);
  expect(
    (
      await handlers.create(
        request(JSON.stringify({ buildId: build })),
        project,
      )
    ).status,
  ).toBe(202);
  expect(
    await (
      await handlers.create(
        request(JSON.stringify({ buildId: build })),
        project,
      )
    ).json(),
  ).toEqual({ deploymentId: id, replayed: true });
  const unauth = createDeploymentHttpHandlers({
    enabled: true,
    userId: async () => null,
    admit: async () => {
      throw new Error("Should not admit");
    },
    get: async () => null,
  });
  expect((await unauth.create(request("{}"), project)).status).toBe(401);
});
test("status remains owner-scoped and disabled publishing never admits", async () => {
  const handlers = createDeploymentHttpHandlers({
    enabled: false,
    userId: async () => "owner",
    admit: async () => {
      throw new Error("Should not admit");
    },
    get: async (user, projectId, deploymentId) => {
      expect([user, projectId, deploymentId]).toEqual(["owner", project, id]);
      return null;
    },
  });
  expect(
    (await handlers.create(new Request("http://api.test"), project)).status,
  ).toBe(503);
  expect(
    (await handlers.get(new Request("http://api.test"), project, id)).status,
  ).toBe(404);
});

test("a stalled admission body expires without admitting work and cancels its reader", async () => {
  let cancelled = false;
  let admissions = 0;
  const handlers = createDeploymentHttpHandlers({
    enabled: true,
    userId: async () => "owner",
    admit: async () => {
      admissions++;
      return { deploymentId: id, replayed: false };
    },
    get: async () => null,
  });
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
  });
  const response = await handlers.create(
    new Request("http://api.test", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body,
    }),
    project,
  );
  expect(response.status).toBe(408);
  expect(cancelled).toBe(true);
  expect(admissions).toBe(0);
}, 8000);

test("history validates bounded pages, retains disabled publishing history and distinguishes failures from empty", async () => {
  const calls: number[] = [];
  const handlers = createDeploymentHttpHandlers({
    enabled: false,
    userId: async () => "viewer",
    admit: async () => {
      throw new Error("History cannot admit");
    },
    get: async () => null,
    list: async (actor, offset) => {
      expect(actor).toBe("viewer");
      calls.push(offset);
      return { deployments: [], nextOffset: null };
    },
  });
  const request = (query = ""): Request =>
    new Request(`http://api.test/api/deployments${query}`);
  for (const query of [
    "?offset=-1",
    "?offset=10001",
    "?offset=1.2",
    "?offset=0&token=secret",
    "?offset=0&offset=24",
  ])
    expect((await handlers.list(request(query))).status).toBe(400);
  expect(calls).toEqual([]);
  const response = await handlers.list(request("?offset=24"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ deployments: [], nextOffset: null });
  expect(calls).toEqual([24]);
  const failed = createDeploymentHttpHandlers({
    enabled: true,
    userId: async () => "viewer",
    admit: async () => {
      throw new Error();
    },
    get: async () => null,
    list: async () => {
      throw new Error("secret provider diagnostic");
    },
  });
  expect((await failed.list(request())).status).toBe(503);
  expect(await (await failed.list(request())).text()).not.toContain(
    "secret provider diagnostic",
  );
  const unauth = createDeploymentHttpHandlers({
    enabled: true,
    userId: async () => null,
    admit: async () => {
      throw new Error();
    },
    get: async () => null,
    list: async () => {
      throw new Error("Should not read");
    },
  });
  expect((await unauth.list(request())).status).toBe(401);
});

test("deployment responses never cache session-bound status or authorization errors", async () => {
  for (const actor of ["owner", null]) {
    const handlers = createDeploymentHttpHandlers({
      enabled: true,
      userId: async () => actor,
      admit: async () => ({ deploymentId: id, replayed: false }),
      get: async () => ({ id, buildId: build, status: "success" }),
      latest: async () => ({ id, buildId: build, status: "success" }),
    });
    for (const response of [
      await handlers.get(new Request("http://api.test"), project, id),
      await handlers.latest(
        new Request(`http://api.test?buildId=${build}`),
        project,
      ),
      await handlers.create(
        new Request("http://api.test", {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify({ buildId: build }),
        }),
        project,
      ),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (!actor) expect(response.status).toBe(401);
    }
  }
});
