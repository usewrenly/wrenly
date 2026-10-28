import { expect, test } from "bun:test";
import { createLegacyRecoveryHandlers } from "../../recovery/legacy-project-recovery-http";
import { LegacyRecoveryError } from "../../recovery/legacy-project-recovery-store";
const request = (body = "{}", origin = "http://localhost:3000"): Request =>
  new Request("http://localhost:3002/api/instance/legacy-projects/review", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body,
  });
test("legacy recovery requires session, trusted origin and bounded JSON before service calls", async () => {
  let userId: string | null = null;
  let calls = 0;
  const handlers = createLegacyRecoveryHandlers({
    webUrl: "http://localhost:3000",
    session: async () => userId,
    list: async () => {
      calls++;
      return { projects: [] };
    },
    review: async (id) => {
      calls++;
      return { actor: id };
    },
    confirm: async () => {
      calls++;
      return { transferred: 1 };
    },
  });
  expect(
    (await handlers.list(new Request("http://localhost:3002"))).status,
  ).toBe(401);
  expect((await handlers.review(request())).status).toBe(401);
  userId = "owner";
  expect(
    (await handlers.review(request("{}", "http://attacker.test"))).status,
  ).toBe(403);
  expect((await handlers.review(request("x".repeat(8193)))).status).toBe(400);
  expect((await handlers.review(request("{"))).status).toBe(400);
  expect(calls).toBe(0);
  const response = await handlers.review(request());
  expect(await response.json()).toEqual({ actor: "owner" });
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("legacy recovery preserves owner denial and safe service failures", async () => {
  const handlers = createLegacyRecoveryHandlers({
    webUrl: "http://localhost:3000",
    session: async () => "other",
    list: async () => {
      throw new LegacyRecoveryError(
        403,
        "Only the verified owner can recover projects.",
      );
    },
    review: async () => {
      throw new Error("private database details");
    },
    confirm: async () => {
      throw new LegacyRecoveryError(409, "Stop active previews first.");
    },
  });
  expect(
    (await handlers.list(new Request("http://localhost:3002"))).status,
  ).toBe(403);
  const unavailable = await handlers.review(request());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.text()).not.toContain("private database");
  expect((await handlers.confirm(request())).status).toBe(409);
});
