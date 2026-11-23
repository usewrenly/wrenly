import { expect, test } from "bun:test";
import { createProductionSetupHttpHandlers, type ProductionSetupHttpServices } from "./http";
const project = crypto.randomUUID(), requestId = crypto.randomUUID();
const principal = { userId: "owner", sessionId: "session", revision: crypto.randomUUID() };
const receipt = { setupId: crypto.randomUUID(), status: "queued", replayed: false };
const input = { requestId, expectedRevision: crypto.randomUUID(), confirmTarget: true, target: { version: 1, environment: "production", host: "database.internal.test", port: 5432, database: "app", sslmode: "verify-full" }, credential: { user: "setup", password: "private" } };
function fixture() {
  const calls: string[] = [];
  const services: ProductionSetupHttpServices = {
    principal: async () => principal,
    admit: async () => { calls.push("admit"); return receipt; },
    read: async () => { calls.push("read"); return receipt; },
    acknowledge: async () => { calls.push("acknowledge"); return { ...receipt, status: "failed" }; },
  };
  return { calls, services, handlers: () => createProductionSetupHttpHandlers(services, "https://wrenly.example.test") };
}
function post(body: unknown = input, origin = "https://wrenly.example.test"): Request {
  return new Request("https://wrenly.example.test/setup", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
test("authentication and trusted origin precede saving or reading any request", async () => {
  const { services, handlers, calls } = fixture();
  services.principal = async () => null;
  expect((await handlers().submit(post(), project)).status).toBe(401);
  services.principal = async () => principal;
  expect((await handlers().submit(post(input, "https://foreign.example.test"), project)).status).toBe(403);
  expect(calls).toEqual([]);
});
test("bounded valid confirmation returns only a private receipt and GET never admits", async () => {
  const { handlers, calls } = fixture();
  const response = await handlers().submit(post(), project);
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(receipt);
  expect((await handlers().status(new Request("https://wrenly.example.test/setup"), project, requestId)).status).toBe(200);
  expect(calls).toEqual(["admit", "read"]);
});
test("malformed, oversized and unconfirmed requests never reach admission", async () => {
  const { handlers, calls } = fixture();
  expect((await handlers().submit(post({ ...input, confirmTarget: false }), project)).status).toBe(400);
  expect((await handlers().submit(post({ ...input, extra: "ignored?" }), project)).status).toBe(400);
  expect((await handlers().submit(post({ extra: "x".repeat(25 * 1024) }), project)).status).toBe(413);
  expect((await handlers().status(new Request("https://wrenly.example.test/setup?secret=value"), project, requestId)).status).toBe(400);
  expect(calls).toEqual([]);
});
test("a changed session withholds a saved acknowledgement without resubmitting", async () => {
  const { services, handlers, calls } = fixture(); let reads = 0;
  services.principal = async () => ++reads === 1 ? principal : { ...principal, sessionId: "another" };
  expect((await handlers().submit(post(), project)).status).toBe(401);
  expect(calls).toEqual(["admit"]);
});
test("provider details and unexpected secret fields cannot cross the receipt boundary", async () => {
  const { services, handlers } = fixture();
  services.admit = async () => { throw new Error("private provider password"); };
  const failed = await handlers().submit(post(), project);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("password");
  services.admit = async () => ({ ...receipt, credential: "private" });
  const invalid = await handlers().submit(post(), project);
  expect(invalid.status).toBe(503);
  expect(await invalid.text()).not.toContain("credential");
});
test("interrupted-check acknowledgement requires its literal confirmation", async () => {
  const { handlers, calls } = fixture();
  expect((await handlers().acknowledge(post({ requestId, expectedRevision: input.expectedRevision, confirmInterruptedCheck: true }), project)).status).toBe(200);
  expect(calls).toEqual(["acknowledge"]);
});
