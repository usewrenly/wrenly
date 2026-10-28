import { describe, expect, test } from "bun:test";
import {
  createBuildHttpHandlers,
  type BuildHttpDependencies,
} from "../../http/http";
import { BuildAdmissionError } from "../../admission/build-admission";
import type {
  BuildSnapshot,
  SavedBuildEvent,
} from "../../persistence/build-queries";

const ID = "101e4567-e89b-12d3-a456-426614174007";
function fixture(): {
  dependencies: BuildHttpDependencies;
  snapshot: BuildSnapshot;
  saved: SavedBuildEvent[];
} {
  const snapshot: BuildSnapshot = {
    build: {
      id: ID,
      projectId: ID,
      prompt: "Build",
      model: "test-model",
      provider: "test-provider",
      stack: "nextjs",
      parentBuildId: null,
      status: "success",
      attemptCount: 1,
      files: [{ path: "package.json", content: "{}" }],
      buildLog: "Compiled",
      errorMessage: null,
      deployedUrl: null,
      createdAt: new Date(),
      completedAt: new Date(),
    },
    outcome: "success",
    cursor: 2,
  };
  const saved: SavedBuildEvent[] = [
    {
      buildId: ID,
      sequence: 1,
      type: "status",
      data: { phase: "generating" },
      createdAt: new Date(),
    },
    {
      buildId: ID,
      sequence: 2,
      type: "complete",
      data: { success: true },
      createdAt: new Date(),
    },
  ];
  return {
    snapshot,
    saved,
    dependencies: {
      userId: async () => "owner",
      admit: async () => ({ buildId: ID, replayed: false }),
      snapshot: async () => snapshot,
      events: async (_id, _user, after) =>
        saved.filter((event) => event.sequence > after),
      cancel: async () => true,
    },
  };
}
function request(path = ""): Request {
  return new Request(`http://localhost/api/builds/${ID}${path}`);
}

describe("durable build HTTP contract", () => {
  test("authorizes before snapshot/events/cancellation and validates IDs", async () => {
    const f = fixture();
    let reads = 0;
    f.dependencies.snapshot = async () => {
      reads++;
      return f.snapshot;
    };
    f.dependencies.userId = async () => null;
    const handlers = createBuildHttpHandlers(f.dependencies);
    expect((await handlers.get(request(), ID)).status).toBe(401);
    expect((await handlers.events(request(), ID)).status).toBe(401);
    expect((await handlers.cancel(request(), ID)).status).toBe(401);
    expect(reads).toBe(0);
    f.dependencies.userId = async () => "owner";
    expect((await handlers.get(request(), "bad-id")).status).toBe(400);
    expect(reads).toBe(0);
  });
  test("missing or foreign builds return 404 before stream headers", async () => {
    const f = fixture();
    f.dependencies.snapshot = async () => null;
    const response = await createBuildHttpHandlers(f.dependencies).events(
      request(),
      ID,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
  test("snapshot contains canonical state and a replay cursor with no cache", async () => {
    const response = await createBuildHttpHandlers(fixture().dependencies).get(
      request(),
      ID,
    );
    expect((await response.json()).cursor).toBe(2);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  test("replays stable IDs after a cursor and ends on persisted completion", async () => {
    const response = await createBuildHttpHandlers(
      fixture().dependencies,
    ).events(request("?after=1"), ID);
    expect(await response.text()).toBe(
      'id: 2\nevent: complete\ndata: {"success":true}\n\n',
    );
  });
  test("accepts Last-Event-ID and rejects invalid/future cursors", async () => {
    const handlers = createBuildHttpHandlers(fixture().dependencies);
    const headerRequest = new Request(request(), {
      headers: { "Last-Event-ID": "1" },
    });
    expect(await (await handlers.events(headerRequest, ID)).text()).toContain(
      "id: 2",
    );
    for (const cursor of ["-1", "1.5", "abc", "9007199254740992", "3"])
      expect(
        (await handlers.events(request(`?after=${cursor}`), ID)).status,
      ).toBe(400);
  });
  test("completed snapshot at latest cursor closes without inventing another event", async () => {
    const response = await createBuildHttpHandlers(
      fixture().dependencies,
    ).events(request("?after=2"), ID);
    expect(await response.text()).toBe("");
  });
  test("admission returns 202, replay returns 200 and typed conflicts stay actionable", async () => {
    const f = fixture();
    const createRequest = (): Request =>
      new Request("http://localhost/api/builds", {
        method: "POST",
        headers: { "Idempotency-Key": ID },
        body: JSON.stringify({ projectId: ID, prompt: "Build" }),
      });
    const handlers = createBuildHttpHandlers(f.dependencies);
    expect((await handlers.create(createRequest())).status).toBe(202);
    f.dependencies.admit = async (_body, user, key) => {
      expect(user).toBe("owner");
      expect(key).toBe(ID);
      return { buildId: ID, replayed: true };
    };
    expect((await handlers.create(createRequest())).status).toBe(200);
    f.dependencies.admit = async () => {
      throw new BuildAdmissionError(409, "Project already active");
    };
    expect((await handlers.create(createRequest())).status).toBe(409);
    expect(
      (
        await handlers.create(
          new Request("http://localhost/api/builds", {
            method: "POST",
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
  });
  test("cancel is an explicit owned action and does not run through a stream disconnect", async () => {
    const f = fixture();
    let cancellations = 0;
    f.dependencies.cancel = async () => {
      cancellations++;
      return true;
    };
    f.snapshot.outcome = "running";
    f.snapshot.cursor = 0;
    f.dependencies.events = async () => [];
    const handlers = createBuildHttpHandlers(f.dependencies);
    const response = await handlers.events(request(), ID);
    await response.body!.cancel();
    expect(cancellations).toBe(0);
    expect((await handlers.cancel(request(), ID)).status).toBe(200);
    expect(cancellations).toBe(1);
  });
  test("event gaps and persistence failures reject the connection without fabricated outcomes", async () => {
    const f = fixture();
    f.saved.shift();
    const handlers = createBuildHttpHandlers(f.dependencies);
    await expect((await handlers.events(request(), ID)).text()).rejects.toThrow(
      "connection failed",
    );
    f.dependencies.snapshot = async () => {
      throw new Error("Secret database parameters");
    };
    const response = await handlers.get(request(), ID);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Secret");
  });
});

test("build replay reauthorizes before delivering further output after revocation", async () => {
  const f = fixture();
  let active = true,
    reads = 0;
  f.snapshot.outcome = "running";
  f.snapshot.cursor = 0;
  f.saved.length = 0;
  f.dependencies.userId = async () => (active ? "owner" : null);
  f.dependencies.snapshot = async () => {
    reads++;
    return f.snapshot;
  };
  const response = await createBuildHttpHandlers(f.dependencies).events(
    request("/events"),
    ID,
  );
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  const before = reads;
  active = false;
  await expect(reader.read()).rejects.toThrow();
  expect(reads).toBe(before);
});

test("activity endpoint returns only safe metadata and retains authorization/error handling", async () => {
  const f = fixture();
  f.snapshot.activity = [
    {
      sequence: 1,
      attempt: 1,
      operation: "generation",
      state: "started",
      occurredAt: new Date().toISOString(),
    },
  ];
  const handlers = createBuildHttpHandlers(f.dependencies);
  const response = await handlers.activity(request("/activity"), ID);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(data).sort()).toEqual([
    "activity",
    "buildId",
    "cursor",
    "outcome",
  ]);
  expect(JSON.stringify(data)).not.toContain("package.json");
  f.dependencies.userId = async () => null;
  expect((await handlers.activity(request(), ID)).status).toBe(401);
  f.dependencies.userId = async () => "owner";
  expect((await handlers.activity(request(), "invalid")).status).toBe(400);
  f.dependencies.snapshot = async () => null;
  expect((await handlers.activity(request(), ID)).status).toBe(404);
  f.dependencies.snapshot = async () => {
    throw new Error("private error");
  };
  const failed = await handlers.activity(request(), ID);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private error");
});
