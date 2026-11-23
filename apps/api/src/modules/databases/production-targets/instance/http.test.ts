/** Transport acceptance never opens a server connection or sends setup credentials externally. */
import { expect, test } from "bun:test";
import {
  createInstanceProductionHttpHandlers,
  type InstanceProductionHttpServices,
} from "./http";
const principal = {
  userId: "owner",
  sessionId: "session",
  revision: crypto.randomUUID(),
};
const input = {
  requestId: crypto.randomUUID(),
  expectedConnectionId: null,
  confirmTarget: true,
  target: {
    version: 1,
    environment: "production",
    host: "apps.internal.test",
    port: 5432,
    database: "maintenance",
    sslmode: "verify-full",
  },
  credential: { user: "postgres", password: "fixture-private-password" },
};
const receipt = {
  connectionId: crypto.randomUUID(),
  status: "queued",
  replayed: false,
};
function request(
  body: unknown = input,
  origin = "http://localhost:3000",
): Request {
  return new Request("http://localhost:3002/api/instance/production-database", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function services(
  overrides: Partial<InstanceProductionHttpServices> = {},
): InstanceProductionHttpServices {
  return {
    principal: async () => principal,
    admit: async () => receipt,
    read: async () => null,
    acknowledge: async () => ({ ...receipt, status: "failed" }),
    ...overrides,
  };
}
test("connection submit returns only private safe receipt and exact lookup never resends secrets", async () => {
  let submissions = 0;
  let readRequest: string | undefined;
  const handlers = createInstanceProductionHttpHandlers(
    services({
      admit: async (_principal, value) => {
        submissions++;
        expect(value.requestId).toBe(input.requestId);
        return receipt;
      },
      read: async (_principal, id) => {
        readRequest = id;
        return {
          connectionId: receipt.connectionId,
          status: "verified",
          target: input.target,
          verified: {
            clusterId: "12345",
            database: "maintenance",
            setupRole: "postgres",
            serverVersion: 170000,
          },
        };
      },
    }),
    "http://localhost:3000",
  );
  const response = await handlers.submit(request());
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(receipt);
  const status = await handlers.status(
    new Request("http://localhost:3002/api/instance/production-database"),
    input.requestId,
  );
  expect(status.status).toBe(200);
  expect(await status.text()).not.toContain(input.credential.password);
  expect(readRequest).toBe(input.requestId);
  expect(submissions).toBe(1);
});
test("wrong origin, missing session and extra fields are refused before admission", async () => {
  let submissions = 0;
  const handlers = createInstanceProductionHttpHandlers(
    services({
      admit: async () => {
        submissions++;
        return receipt;
      },
    }),
    "http://localhost:3000",
  );
  expect(
    (await handlers.submit(request(input, "https://foreign.test"))).status,
  ).toBe(403);
  expect(
    (await handlers.submit(request({ ...input, command: "execute" }))).status,
  ).toBe(400);
  expect(
    (
      await handlers.submit(
        request({
          ...input,
          credential: { ...input.credential, password: "x".repeat(30_000) },
        }),
      )
    ).status,
  ).toBe(413);
  const signedOut = createInstanceProductionHttpHandlers(
    services({ principal: async () => null }),
    "http://localhost:3000",
  );
  expect((await signedOut.submit(request())).status).toBe(401);
  expect(submissions).toBe(0);
});
test("changed sessions and malformed service responses never expose stored secrets", async () => {
  let checks = 0;
  const changed = createInstanceProductionHttpHandlers(
    services({
      principal: async () =>
        ++checks === 1 ? principal : { ...principal, sessionId: "other" },
    }),
    "http://localhost:3000",
  );
  expect((await changed.submit(request())).status).toBe(401);
  const malformed = createInstanceProductionHttpHandlers(
    services({
      admit: async () => ({ ...receipt, secret: input.credential.password }),
    }),
    "http://localhost:3000",
  );
  const response = await malformed.submit(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(input.credential.password);
  const missing = createInstanceProductionHttpHandlers(
    services(),
    "http://localhost:3000",
  );
  expect(
    (
      await missing.status(
        new Request("http://localhost:3002/api/instance/production-database"),
        input.requestId,
      )
    ).status,
  ).toBe(404);
});
