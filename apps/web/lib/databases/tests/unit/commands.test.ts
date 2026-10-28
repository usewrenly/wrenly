/** Admission recovery must preserve exact requests and keep another actor's pending work separate. */
import { expect, test } from "bun:test";
import { DatabaseCommandError, lookupDatabaseAction, submitDatabaseAction } from "../../commands";
import { savePendingDatabaseAction, readPendingDatabaseAction, clearPendingDatabaseAction } from "../../pending-action";
const projectId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
const action = { requestId: "00000000-0000-4000-8000-000000000003", expectedRevision: resourceId,
  kind: "backup" as const, environment: "development" as const };
const receipt = { operationId: "00000000-0000-4000-8000-000000000004", resourceId, replayed: true };

test("lost acknowledgement retries retain the byte-identical request and lookup does not send a command", async () => {
  const bodies: string[] = [];
  const transport: NonNullable<Parameters<typeof submitDatabaseAction>[3]> = async (_path, options) => {
    bodies.push(String(options.body));
    return bodies.length === 1 ? new Response("unconfirmed", { status: 503 }) : Response.json(receipt);
  };
  await expect(submitDatabaseAction(projectId, action, new AbortController().signal, transport)).rejects.toMatchObject({ rejected: false });
  expect(await submitDatabaseAction(projectId, action, new AbortController().signal, transport)).toEqual(receipt);
  expect(bodies[0]).toBe(bodies[1]);
  expect(await lookupDatabaseAction(projectId, action.requestId, new AbortController().signal, async (_path, options) => {
    expect(options.method).toBeUndefined(); return Response.json({ acknowledgement: null });
  })).toBeNull();
  expect(bodies).toHaveLength(2);
});
test("definitive rejection stays distinct from unknown, malformed and secret-bearing acknowledgements", async () => {
  await expect(submitDatabaseAction(projectId, action, new AbortController().signal,
    async () => new Response("PRIVATE_DATABASE_ERROR", { status: 409 }))).rejects.toMatchObject({ rejected: true });
  try {
    await submitDatabaseAction(projectId, action, new AbortController().signal,
      async () => Response.json({ ...receipt, credentials: "PRIVATE_SECRET" }));
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseCommandError);
    expect((error as Error).message).not.toContain("PRIVATE_SECRET");
  }
});
test("pending storage survives restoration, isolates actors and refuses to clear a replacement request", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
    removeItem: (key: string): void => { values.delete(key); } };
  const pending = { version: 1 as const, actorId: "actor-a", projectId, resourceId, action };
  savePendingDatabaseAction(storage, pending);
  expect(readPendingDatabaseAction(storage, "actor-a", projectId)).toEqual(pending);
  expect(readPendingDatabaseAction(storage, "actor-b", projectId)).toBeNull();
  const replacement = { ...pending, action: { ...action, requestId: crypto.randomUUID() } };
  savePendingDatabaseAction(storage, replacement);
  expect(() => clearPendingDatabaseAction(storage, pending)).toThrow("Another action");
  clearPendingDatabaseAction(storage, replacement);
  expect(readPendingDatabaseAction(storage, "actor-a", projectId)).toBeNull();
});


test("recovery commands and their receipts use the recovery boundary with a frozen operation", async () => {
  const action = { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: crypto.randomUUID(),
    kind: "recover-runtime-state" as const, confirmRecovery: true as const };
  const project = crypto.randomUUID();
  const receipt = { operationId: crypto.randomUUID(), resourceId: crypto.randomUUID(), replayed: false };
  await submitDatabaseAction(project, action, new AbortController().signal, async (path, options) => {
    expect(path).toBe(`/api/projects/${project}/databases/recovery`);
    expect(JSON.parse(String(options.body))).toEqual(action); return Response.json(receipt, { status: 202 });
  });
  expect(await lookupDatabaseAction(project, action.requestId, new AbortController().signal, async path => {
    expect(path).toBe(`/api/projects/${project}/databases/recovery/${action.requestId}`);
    return Response.json({ acknowledgement: receipt });
  }, true)).toEqual(receipt);
});
