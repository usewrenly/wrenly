import { expect, test } from "bun:test";
import { createDatabaseViewHandler } from "./view-http";
import { AppDatabaseError } from "../database-contract";

const project = crypto.randomUUID(),
  resource = crypto.randomUUID(),
  revision = crypto.randomUUID();
const url = `http://localhost/api/projects/${project}/database/view?resourceId=${resource}&revision=${revision}&environment=development&rows=false`;
const authority = {
  accessRevision: crypto.randomUUID(),
  resourceId: resource,
  resourceRevision: revision,
};
const result = {
  tables: [],
  table: null,
  columns: [],
  rows: [],
  sample: false,
  nextKey: null,
  truncatedColumns: false,
};

test("viewer HTTP requires authentication and returns uncached exact reads", async () => {
  let calls = 0;
  const deps = {
    userId: async () => null as string | null,
    authority: async () => authority,
    query: async () => {
      calls++;
      return result;
    },
  };
  const handler = createDatabaseViewHandler(deps);
  expect((await handler(new Request(url), project)).status).toBe(401);
  expect(calls).toBe(0);
  deps.userId = async () => "actor";
  const response = await handler(new Request(url), project);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(result);
});

test("viewer rejects duplicated/unknown input before opening a query", async () => {
  let calls = 0;
  const handler = createDatabaseViewHandler({
    userId: async () => "actor",
    authority: async () => authority,
    query: async () => {
      calls++;
      return result;
    },
  });
  for (const suffix of [
    "&rows=true",
    "&sql=SELECT+1",
    "&password=secret",
    "&after=" + "x".repeat(2048),
  ])
    expect((await handler(new Request(url + suffix), project)).status).toBe(
      400,
    );
  expect(
    (await handler(new Request(url, { method: "POST" }), project)).status,
  ).toBe(405);
  expect(calls).toBe(0);
});

test("expired sessions discard rows and safe authorization errors preserve their status", async () => {
  let reads = 0;
  const handler = createDatabaseViewHandler({
    userId: async () => (++reads === 1 ? "actor" : null),
    authority: async () => authority,
    query: async () => result,
  });
  const response = await handler(new Request(url), project);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('"tables"');
  const forbidden = createDatabaseViewHandler({
    userId: async () => "actor",
    authority: async () => {
      throw new AppDatabaseError(403, "Rows are not permitted.");
    },
    query: async () => result,
  });
  expect((await forbidden(new Request(url), project)).status).toBe(403);
});
