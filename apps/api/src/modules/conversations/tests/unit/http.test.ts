import { describe, expect, test } from "bun:test";
import { createConversationHttpHandlers } from "../../http/http";
import {
  ConversationStoreError,
  type ConversationTurnSnapshot,
} from "../../persistence/conversation-store";
import { createApp } from "../../../../app";

const ID = "101e4567-e89b-12d3-a456-426614174007";
function fixture(): {
  handlers: ReturnType<typeof createConversationHttpHandlers>;
  calls: string[];
  snapshot: ConversationTurnSnapshot;
} {
  const calls: string[] = [];
  const snapshot: ConversationTurnSnapshot = {
    id: ID,
    conversationId: ID,
    mode: "ask",
    baseBuildId: null,
    status: "completed",
    errorMessage: null,
    cursor: 2,
    nextCursor: null,
    events: [
      {
        turnId: ID,
        sequence: 1,
        type: "status",
        data: { status: "queued" },
        createdAt: new Date(),
      },
      {
        turnId: ID,
        sequence: 2,
        type: "complete",
        data: { status: "completed" },
        createdAt: new Date(),
      },
    ],
  };
  const handlers = createConversationHttpHandlers({
    userId: async (headers) =>
      headers.get("authorization") === "owner" ? "owner" : null,
    admit: async (_, __, key) => {
      calls.push("admit");
      if (!key) throw new ConversationStoreError(400, "Missing key");
      return { turnId: ID, conversationId: ID, replayed: key === "replay" };
    },
    history: async (_, __, after, limit) => {
      calls.push("history");
      return { messages: [], after, limit };
    },
    snapshot: async (_, __, after) => {
      calls.push("snapshot");
      return {
        ...snapshot,
        events: snapshot.events.filter((event) => event.sequence > after),
      };
    },
    cancel: async () => {
      calls.push("cancel");
      return true;
    },
  });
  return { handlers, calls, snapshot };
}
function request(
  path = "/",
  body?: unknown,
  key: string = crypto.randomUUID(),
): Request {
  return new Request("http://localhost" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "owner",
      "Idempotency-Key": key,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("conversation HTTP adapter", () => {
  test("authenticates before reading or admitting a message and rejects invalid IDs", async () => {
    const f = fixture();
    expect(
      (
        await f.handlers.create(
          new Request("http://localhost", { method: "POST", body: "invalid" }),
          ID,
        )
      ).status,
    ).toBe(401);
    expect((await f.handlers.get(request(), "invalid")).status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test("admits Ask with 202, replays with 200, and uses private cache headers", async () => {
    const f = fixture();
    const response = await f.handlers.create(
      request("/", { mode: "ask", message: "Why did it fail?" }),
      ID,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await f.handlers.create(
          request("/", { mode: "ask", message: "Hello" }, "replay"),
          ID,
        )
      ).status,
    ).toBe(200);
  });
  test("rejects malformed/oversized bodies before admission", async () => {
    const f = fixture();
    expect(
      (
        await f.handlers.create(
          new Request("http://localhost", {
            method: "POST",
            headers: { authorization: "owner" },
            body: "x".repeat(96001),
          }),
          ID,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.handlers.create(
          new Request("http://localhost", {
            method: "POST",
            headers: { authorization: "owner" },
            body: "{",
          }),
          ID,
        )
      ).status,
    ).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test("admits Auto by default and the explicit Build override", async () => {
    const f = fixture();
    for (const body of [
      { message: "Auto by default" },
      { message: "Build", mode: "build" },
    ])
      expect((await f.handlers.create(request("/", body), ID)).status).toBe(
        202,
      );
    expect(f.calls).toEqual(["admit", "admit"]);
  });
  test("aborted slow bodies are cancelled without admitting a turn", async () => {
    const f = fixture();
    const controller = new AbortController();
    let cancelled = false;
    const req = new Request("http://localhost", {
      method: "POST",
      headers: { authorization: "owner" },
      signal: controller.signal,
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    const pending = f.handlers.create(req, ID);
    await Bun.sleep(5);
    controller.abort();
    expect((await pending).status).toBe(400);
    expect(cancelled).toBe(true);
    expect(f.calls).toEqual([]);
  });
  test("validates replay cursors and prefers an explicit query cursor over Last-Event-ID", async () => {
    const f = fixture();
    for (const cursor of ["-1", "NaN", "1.5", "999999999999999999999999"])
      expect(
        (await f.handlers.events(request("/?after=" + cursor), ID)).status,
      ).toBe(400);
    expect((await f.handlers.events(request("/?after=3"), ID)).status).toBe(
      400,
    );
    const req = request("/?after=1");
    req.headers.set("Last-Event-ID", "0");
    const response = await f.handlers.events(req, ID);
    const text = await response.text();
    expect(text).not.toContain("id: 1\n");
    expect(text).toContain("id: 2\n");
    expect(text).toContain("event: complete");
  });
  test("subscriber cancellation does not cancel execution; explicit cancellation does", async () => {
    const f = fixture();
    f.snapshot.status = "running";
    f.snapshot.cursor = 0;
    f.snapshot.events = [];
    const response = await f.handlers.events(request(), ID);
    await response.body?.cancel();
    expect(f.calls).not.toContain("cancel");
    expect((await f.handlers.cancel(request(), ID)).status).toBe(200);
    expect(f.calls).toContain("cancel");
  });
  test("mounts conversation paths under the existing Hono origin guard", async () => {
    const f = fixture();
    const ok = async (): Promise<Response> => Response.json({ ok: true });
    const app = createApp(
      {
        conversations: f.handlers,
        listProjects: ok,
        createProject: ok,
        getProject: ok,
        deployProject: ok,
        getModels: ok,
        generate: ok,
        auth: ok,
      },
      { web: "http://localhost:3000", api: "http://localhost:3002" },
    );
    expect(
      (await app.fetch(request("/api/projects/" + ID + "/messages"))).status,
    ).toBe(200);
    const forbidden = request("/api/projects/" + ID + "/messages", {
      mode: "ask",
      message: "Hello",
    });
    forbidden.headers.set("origin", "http://attacker.test");
    expect((await app.fetch(forbidden)).status).toBe(403);
    expect(
      await app.fetch(request("/api/conversation-turns/" + ID)),
    ).toBeInstanceOf(Response);
    expect(f.calls).not.toContain("admit");
  });
});

test("conversation replay reauthorizes before further snapshots after revocation", async () => {
  const f = fixture();
  f.snapshot.status = "running";
  f.snapshot.cursor = 0;
  f.snapshot.events = [];
  let active = true,
    reads = 0;
  const handlers = createConversationHttpHandlers({
    userId: async () => (active ? "owner" : null),
    admit: async () => ({ turnId: ID, conversationId: ID, replayed: false }),
    history: async () => ({ messages: [], after: 0, limit: 50 }),
    snapshot: async () => {
      reads++;
      return f.snapshot;
    },
    cancel: async () => true,
  });
  const response = await handlers.events(request(), ID);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  const before = reads;
  active = false;
  await expect(reader.read()).rejects.toThrow();
  expect(reads).toBe(before);
});
