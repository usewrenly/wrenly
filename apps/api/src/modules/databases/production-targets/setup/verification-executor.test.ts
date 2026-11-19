import { expect, test } from "bun:test";
import { executeProductionVerification, type ProductionVerificationDependencies } from "./verification-executor";
const claim = { id: crypto.randomUUID(), token: crypto.randomUUID(), principal: { userId: "owner", sessionId: "session", revision: crypto.randomUUID() } };
function fixture() {
  const outcomes: unknown[] = [];
  const target = { version: 1 as const, environment: "production" as const, host: "database.internal.test", port: 5432, database: "app", sslmode: "verify-full" as const };
  const dependencies: ProductionVerificationDependencies = {
    load: async () => ({ target, credential: { user: "setup", password: "private" } }),
    controlIdentity: async () => "123",
    pin: async (value) => ({ target: value, addresses: ["10.0.0.2"] }),
    inspect: async (input) => { expect(input.controlClusterId).toBe("123"); return { clusterId: "456", database: "app", setupRole: "setup", serverVersion: 170000 }; },
    finish: async (_, outcome) => { outcomes.push(outcome); return { setupId: claim.id, status: outcome.status === "refused" ? "failed" : outcome.status === "interrupted" ? "needs_review" : "verified", replayed: false }; },
  };
  return { dependencies, outcomes };
}
test("records verified metadata only after the inspector completes", async () => {
  const { dependencies, outcomes } = fixture();
  expect((await executeProductionVerification(claim, dependencies)).status).toBe("verified");
  expect(JSON.stringify(outcomes)).not.toContain("private");
  expect(outcomes).toHaveLength(1);
});
test("safe refusal hides remote errors and completes once", async () => {
  const { dependencies, outcomes } = fixture();
  dependencies.inspect = async () => { throw new Error("private provider detail"); };
  expect((await executeProductionVerification(claim, dependencies)).status).toBe("failed");
  expect(outcomes).toEqual([{ status: "refused" }]);
});
test("cancellation records review without connecting", async () => {
  const { dependencies, outcomes } = fixture();
  dependencies.load = async () => { throw new Error("must not load"); };
  expect((await executeProductionVerification(claim, dependencies, AbortSignal.abort())).status).toBe("needs_review");
  expect(outcomes).toEqual([{ status: "interrupted" }]);
});
test("an unconfirmed save is never followed by a second refused save", async () => {
  const { dependencies } = fixture(); let calls = 0;
  dependencies.finish = async () => { calls++; throw new Error("database unavailable"); };
  await expect(executeProductionVerification(claim, dependencies)).rejects.toThrow("could not be confirmed");
  expect(calls).toBe(1);
});
test("cancellation after inspection cannot save a verified result", async () => {
  const { dependencies, outcomes } = fixture();
  const cancellation = new AbortController();
  dependencies.inspect = async () => {
    cancellation.abort();
    return { clusterId: "456", database: "app", setupRole: "setup", serverVersion: 170000 };
  };
  expect((await executeProductionVerification(claim, dependencies, cancellation.signal)).status).toBe("needs_review");
  expect(outcomes).toEqual([{ status: "interrupted" }]);
});
