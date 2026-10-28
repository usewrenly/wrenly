// Service calls are injected; no operator DB is touched.
import { expect, test } from "bun:test";
import { createProjectSettingsHandlers } from "../../settings/settings-http";
import {
  ProjectSettingsError,
  ProjectSettingsInput,
} from "../../settings/settings-contract";
const id = "101e4567-e89b-12d3-a456-426614174007";
const details = {
  id,
  name: "Studio",
  description: null,
  stack: "nextjs",
  access: "private" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const input = {
  name: "New studio",
  description: null,
  expected: { name: "Studio", description: null },
};
function fixture() {
  let actor: string | null = "owner";
  const calls: string[] = [];
  let conflict = false;
  let unavailable = false;
  const handlers = createProjectSettingsHandlers({
    webUrl: "http://localhost:3000",
    userId: async () => actor,
    read: async (userId) => {
      calls.push(userId);
      if (unavailable) throw new Error("private database detail");
      return details;
    },
    save: async (userId, _id, change) => {
      calls.push(userId);
      if (conflict)
        throw new ProjectSettingsError(409, "Review saved details.", details);
      return { ...details, name: change.name, description: change.description };
    },
  });
  return {
    handlers,
    calls,
    setActor: (value: string | null) => {
      actor = value;
    },
    fail: () => {
      unavailable = true;
    },
    conflict: () => {
      conflict = true;
    },
  };
}
function request(
  body: unknown = input,
  origin: string | null = "http://localhost:3000",
): Request {
  return new Request("http://localhost:3002/api/projects/" + id + "/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}
test("settings read/save return bounded private projections and normalize input", async () => {
  const f = fixture();
  const get = await f.handlers.get(new Request("http://localhost/api"), id);
  expect(get.headers.get("Cache-Control")).toContain("no-store");
  expect((await get.json()).project.access).toBe("private");
  const result = await f.handlers.save(
    request({ ...input, name: "  New studio  ", description: "  " }),
    id,
  );
  expect(result.status).toBe(200);
  expect((await result.json()).project).toMatchObject({
    name: "New studio",
    description: null,
  });
  expect(f.calls).toEqual(["owner", "owner"]);
});
test("unauthenticated and cross-origin writes never call persistence", async () => {
  const f = fixture();
  f.setActor(null);
  expect(
    (await f.handlers.get(new Request("http://localhost/api"), id)).status,
  ).toBe(401);
  expect((await f.handlers.save(request(), id)).status).toBe(401);
  f.setActor("owner");
  for (const origin of [null, "https://hostile.example"])
    expect((await f.handlers.save(request(input, origin), id)).status).toBe(
      403,
    );
  expect(f.calls).toEqual([]);
});
test("strict bounded contract rejects ownership/stack/visibility/environment changes", async () => {
  const f = fixture();
  for (const extra of [
    { userId: "other" },
    { stack: "laravel" },
    { visibility: "public" },
    { environment: "production" },
    { name: " " },
    { description: "x".repeat(501) },
    { expected: { ...input.expected, access: "public" } },
  ])
    expect(
      (await f.handlers.save(request({ ...input, ...extra }), id)).status,
    ).toBe(400);
  expect(f.calls).toEqual([]);
  expect(
    ProjectSettingsInput.parse({ ...input, description: " useful " })
      .description,
  ).toBe(" useful ");
});
test("invalid JSON/media type and oversized streamed bodies are explicit failures", async () => {
  const f = fixture();
  expect(
    (
      await f.handlers.save(
        new Request("http://localhost/api", {
          method: "PATCH",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: "{",
        }),
        id,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.handlers.save(
        new Request("http://localhost/api", {
          method: "PATCH",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "text/plain",
          },
          body: "hello",
        }),
        id,
      )
    ).status,
  ).toBe(400);
  const large = request({ name: "x".repeat(9000) });
  expect((await f.handlers.save(large, id)).status).toBe(413);
  expect(f.calls).toEqual([]);
});
test("conflicts return reviewed facts and service errors do not expose internals", async () => {
  const f = fixture();
  f.conflict();
  const conflict = await f.handlers.save(request(), id);
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).current.name).toBe("Studio");
  f.fail();
  const failure = await f.handlers.get(new Request("http://localhost/api"), id);
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("private database detail");
});

test("Hono settings routes validate project IDs and apply origin policy before mutation", async () => {
  const { createApp } = await import("../../../../app");
  const f = fixture(),
    empty = async (): Promise<Response> => Response.json({});
  const app = createApp(
    {
      projectSettings: f.handlers,
      listProjects: empty,
      createProject: empty,
      getProject: empty,
      deployProject: empty,
      getModels: empty,
      generate: empty,
      auth: empty,
    },
    { web: "http://localhost:3000", api: "http://localhost:3002" },
  );
  expect((await app.request(`/api/projects/${id}/settings`)).status).toBe(200);
  expect((await app.request("/api/projects/invalid/settings")).status).toBe(
    400,
  );
  expect(
    (
      await app.request(`/api/projects/${id}/settings`, {
        method: "PATCH",
        headers: {
          Origin: "https://hostile.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(`/api/projects/${id}/settings`, {
        method: "PATCH",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(200);
  expect(f.calls).toEqual(["owner", "owner"]);
});
