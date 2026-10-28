/** Browser reads reject cross-project/table data, private fields and oversized streams without trusting server messages. */
import { expect, test } from "bun:test";
import { requestDatabaseStatus, requestDatabaseView } from "../../requests";
const projectId = "00000000-0000-4000-8000-000000000001";
const selection = { resourceId: "00000000-0000-4000-8000-000000000002",
  revision: "00000000-0000-4000-8000-000000000003", environment: "development" as const, rows: false, table: "notes" };
const result = { tables: ["notes"], table: "notes", columns: [], rows: [], sample: false, nextKey: null, truncatedColumns: false };
test("viewer sends explicit revision/rows choices with session-safe no-store transport", async () => {
  const value = await requestDatabaseView(projectId, selection, new AbortController().signal, async (path, options) => {
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe(`/api/projects/${projectId}/databases/view`);
    expect(url.searchParams.get("revision")).toBe(selection.revision);
    expect(url.searchParams.get("rows")).toBe("false");
    expect(options.cache).toBe("no-store");
    return Response.json(result);
  });
  expect(value).toEqual(result);
});
test("schema reads refuse rows, foreign tables and private fields", async () => {
  for (const value of [{ ...result, rows: [["PRIVATE_ROW"]] }, { ...result, table: "other" },
    { ...result, credentials: "PRIVATE_TOKEN" }]) {
    await expect(requestDatabaseView(projectId, selection, new AbortController().signal,
      async () => Response.json(value))).rejects.toThrow("view is unavailable");
  }
});
test("status refuses another project's resource and oversized payloads", async () => {
  const resource = { id: selection.resourceId, projectId: selection.resourceId, environment: "development", provider: "local",
    status: "ready", revision: selection.revision, schemaDigest: null, errorCode: null,
    createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" };
  await expect(requestDatabaseStatus(projectId, new AbortController().signal, async () => Response.json({
    capabilities: { manage: false, developmentRows: false, productionRows: false }, resources: [resource], operations: [],
  }))).rejects.toThrow("status is unavailable");
  await expect(requestDatabaseView(projectId, selection, new AbortController().signal,
    async () => new Response("x".repeat(128 * 1024 + 1)))).rejects.toThrow("view is unavailable");
});
test("cancelled reads cannot return a completed response", async () => {
  const controller = new AbortController();
  await expect(requestDatabaseView(projectId, selection, controller.signal, async () => {
    controller.abort(); return Response.json(result);
  })).rejects.toThrow("view is unavailable");
});
