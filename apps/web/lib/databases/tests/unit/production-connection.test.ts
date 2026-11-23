import { expect, test } from "bun:test";
import {
  acknowledgeProductionConnection,
  readProductionConnection,
  submitProductionConnection,
  ProductionConnectionError,
} from "../../production-connection";
const input = {
  requestId: crypto.randomUUID(),
  expectedConnectionId: null,
  confirmTarget: true as const,
  target: {
    version: 1 as const,
    environment: "production" as const,
    host: "apps.internal.test",
    port: 5432,
    database: "postgres",
    sslmode: "verify-full" as const,
  },
  credential: { user: "manager", password: "fixture-only" },
};
const signal = new AbortController().signal;
test("connection lookup is read-only and validates saved server facts", async () => {
  const connectionId = crypto.randomUUID();
  const state = {
    connectionId,
    status: "checking",
    target: input.target,
    verified: null,
  };
  const result = await readProductionConnection(
    signal,
    input.requestId,
    async (path, options) => {
      expect(path).toBe(
        `/api/instance/production-database/requests/${input.requestId}`,
      );
      expect(options?.method).toBeUndefined();
      expect(options?.body).toBeUndefined();
      return Response.json(state);
    },
  );
  expect(result?.connectionId).toBe(connectionId);
  await expect(
    readProductionConnection(
      signal,
      undefined,
      async () => new Response(null, { status: 404 }),
    ),
  ).rejects.toMatchObject({ reason: "unavailable" });
  await expect(
    readProductionConnection(
      signal,
      input.requestId,
      async () => new Response(null, { status: 404 }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
});
test("setup validates before sending secrets and retains unknown acknowledgements", async () => {
  let calls = 0;
  await expect(
    submitProductionConnection(
      { ...input, confirmTarget: false } as unknown as typeof input,
      signal,
      async () => {
        calls++;
        return Response.json({});
      },
    ),
  ).rejects.toBeInstanceOf(ProductionConnectionError);
  expect(calls).toBe(0);
  const connectionId = crypto.randomUUID();
  expect(
    await submitProductionConnection(input, signal, async (_path, options) => {
      expect(JSON.parse(String(options?.body))).toEqual(input);
      return Response.json({ connectionId, status: "queued", replayed: false });
    }),
  ).toEqual({ connectionId, status: "queued", replayed: false });
  await expect(
    submitProductionConnection(input, signal, async () =>
      Response.json({ credential: input.credential }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
  await expect(
    submitProductionConnection(
      input,
      signal,
      async () => new Response(null, { status: 409 }),
    ),
  ).rejects.toMatchObject({ reason: "rejected" });
});

test("interrupted check acknowledgement cannot confirm another connection", async () => {
  const id = crypto.randomUUID();
  await acknowledgeProductionConnection(id, signal, async (path, options) => {
    expect(path).toBe("/api/instance/production-database/acknowledge");
    expect(JSON.parse(String(options?.body))).toEqual({
      connectionId: id,
      confirmInterruptedCheck: true,
    });
    return Response.json({
      connectionId: id,
      status: "failed",
      replayed: false,
    });
  });
  await expect(
    acknowledgeProductionConnection(id, signal, async () =>
      Response.json({
        connectionId: crypto.randomUUID(),
        status: "failed",
        replayed: false,
      }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
  await expect(
    acknowledgeProductionConnection(id, signal, async () =>
      Response.json({ connectionId: id, status: "verified", replayed: false }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
});
