import { expect, test } from "bun:test";
import { createOwnerRecoveryHandler } from "../../recovery/owner-recovery-http";
const request = (origin = "http://localhost:3000", body = "{}"): Request =>
  new Request("http://localhost:3002/api/instance/recover-owner", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body,
  });
test("recovery authenticates before claim and preserves bounded origin checks", async () => {
  let identity: string | null = null;
  const claims: string[] = [];
  const handler = createOwnerRecoveryHandler({
    webUrl: "http://localhost:3000",
    session: async () => identity,
    claim: async (_input, id) => {
      claims.push(id);
      return { replayed: false };
    },
  });
  expect((await handler(request())).status).toBe(401);
  expect(claims).toHaveLength(0);
  identity = "selected";
  expect((await handler(request("http://attacker.test"))).status).toBe(403);
  expect(
    (await handler(request("http://localhost:3000", "x".repeat(8193)))).status,
  ).toBe(400);
  expect(claims).toHaveLength(0);
  expect((await handler(request())).status).toBe(201);
  expect(claims).toEqual(["selected"]);
});
test("recovery session failure returns safe unavailable response", async () => {
  const handler = createOwnerRecoveryHandler({
    webUrl: "http://localhost:3000",
    session: async () => {
      throw new Error("private");
    },
    claim: async () => {
      throw new Error("must not run");
    },
  });
  const response = await handler(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
