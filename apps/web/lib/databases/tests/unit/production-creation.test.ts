import { expect, test } from "bun:test";
import {
  readProductionCreation,
  submitProductionCreation,
  readPendingProductionCreation,
  savePendingProductionCreation,
  clearPendingProductionCreation,
  type PendingProductionCreation,
} from "../../production-creation";
const projectId = crypto.randomUUID();
const pending: PendingProductionCreation = {
  version: 1,
  actorId: "owner",
  projectId,
  input: {
    requestId: crypto.randomUUID(),
    expectedRevision: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    confirmCreate: true,
  },
};
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
test("recovery identity cannot be replaced or cleared by another request", () => {
  const saved = storage();
  savePendingProductionCreation(saved, pending);
  expect(readPendingProductionCreation(saved, "other", projectId)).toBeNull();
  const other = {
    ...pending,
    input: { ...pending.input, requestId: crypto.randomUUID() },
  };
  expect(() => savePendingProductionCreation(saved, other)).toThrow();
  expect(() => clearPendingProductionCreation(saved, other)).toThrow();
  expect(readPendingProductionCreation(saved, "owner", projectId)).toEqual(
    pending,
  );
  clearPendingProductionCreation(saved, pending);
  expect(readPendingProductionCreation(saved, "owner", projectId)).toBeNull();
});
test("missing exact status preserves uncertainty and foreign status is rejected", async () => {
  const signal = new AbortController().signal;
  expect(
    await readProductionCreation(
      projectId,
      signal,
      pending.input.requestId,
      async () => new Response(null, { status: 404 }),
    ),
  ).toBeNull();
  for (const value of [
    {
      projectId: crypto.randomUUID(),
      projectRevision: pending.input.expectedRevision,
      connectionId: null,
      creation: null,
    },
    {
      projectId,
      projectRevision: pending.input.expectedRevision,
      connectionId: null,
      creation: {
        resourceId: crypto.randomUUID(),
        requestId: pending.input.requestId,
        status: "attached",
        completedPhases: [],
        errorCode: null,
      },
    },
  ])
    await expect(
      readProductionCreation(projectId, signal, undefined, async () =>
        Response.json(value),
      ),
    ).rejects.toThrow();
});
test("retry sends the original identity and distinguishes rejection from lost response", async () => {
  const signal = new AbortController().signal;
  const receipt = {
    resourceId: crypto.randomUUID(),
    status: "queued" as const,
    completedPhases: [],
    replayed: true,
  };
  expect(
    await submitProductionCreation(pending, signal, async (_path, options) => {
      expect(JSON.parse(String(options.body))).toEqual(pending.input);
      return Response.json(receipt);
    }),
  ).toEqual(receipt);
  await expect(
    submitProductionCreation(
      pending,
      signal,
      async () => new Response(null, { status: 409 }),
    ),
  ).rejects.toMatchObject({ reason: "rejected" });
  await expect(
    submitProductionCreation(pending, signal, async () => {
      throw new Error("connection lost");
    }),
  ).rejects.toMatchObject({ reason: "unknown" });
});
