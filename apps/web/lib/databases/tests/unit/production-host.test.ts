import { expect, test } from "bun:test";
import {
  acknowledgeProductionHost,
  readProductionHost,
  submitProductionHost,
  ProductionHostError,
} from "../../production-host";
const input = {
  requestId: crypto.randomUUID(),
  expectedConnectionId: null,
  confirmTarget: true as const,
  serverId: "fixture-server",
  target: {
    host: "deploy.internal.test",
    port: 22,
    user: "wrenly",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
  },
  privateKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only\n-----END OPENSSH PRIVATE KEY-----\n",
};
const signal = new AbortController().signal;
test("connection lookup is read-only and validates saved server facts", async () => {
  const connectionId = crypto.randomUUID();
  const state = {
    connectionId,
    status: "checking",
    serverId: input.serverId,
    target: input.target,
    verified: null,
  };
  const result = await readProductionHost(
    signal,
    input.requestId,
    async (path, options) => {
      expect(path).toBe(
        `/api/instance/deployment-host/requests/${input.requestId}`,
      );
      expect(options?.method).toBeUndefined();
      expect(options?.body).toBeUndefined();
      return Response.json(state);
    },
  );
  expect(result?.connectionId).toBe(connectionId);
  await expect(
    readProductionHost(
      signal,
      undefined,
      async () => new Response(null, { status: 404 }),
    ),
  ).rejects.toMatchObject({ reason: "unavailable" });
  await expect(
    readProductionHost(
      signal,
      input.requestId,
      async () => new Response(null, { status: 404 }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
});
test("setup validates before sending secrets and retains unknown acknowledgements", async () => {
  let calls = 0;
  await expect(
    submitProductionHost(
      { ...input, confirmTarget: false } as unknown as typeof input,
      signal,
      async () => {
        calls++;
        return Response.json({});
      },
    ),
  ).rejects.toBeInstanceOf(ProductionHostError);
  expect(calls).toBe(0);
  const connectionId = crypto.randomUUID();
  expect(
    await submitProductionHost(input, signal, async (_path, options) => {
      expect(JSON.parse(String(options?.body))).toEqual(input);
      return Response.json({ connectionId, status: "queued", replayed: false });
    }),
  ).toEqual({ connectionId, status: "queued", replayed: false });
  await expect(
    submitProductionHost(input, signal, async () =>
      Response.json({ privateKey: input.privateKey }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
  await expect(
    submitProductionHost(
      input,
      signal,
      async () => new Response(null, { status: 409 }),
    ),
  ).rejects.toMatchObject({ reason: "rejected" });
});

test("interrupted check acknowledgement cannot confirm another connection", async () => {
  const id = crypto.randomUUID();
  await acknowledgeProductionHost(id, signal, async (path, options) => {
    expect(path).toBe("/api/instance/deployment-host/acknowledge");
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
    acknowledgeProductionHost(id, signal, async () =>
      Response.json({
        connectionId: crypto.randomUUID(),
        status: "failed",
        replayed: false,
      }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
  await expect(
    acknowledgeProductionHost(id, signal, async () =>
      Response.json({ connectionId: id, status: "verified", replayed: false }),
    ),
  ).rejects.toMatchObject({ reason: "unknown" });
});
