import { expect, test } from "bun:test";
import { createInstanceSetupHandlers } from "../../setup/instance-setup-http";
import { InstanceSetupError } from "../../setup/instance-setup-store";
test("setup requires trusted origin, bounded JSON and explicit service authorization", async () => {
  let calls = 0;
  const handlers = createInstanceSetupHandlers({
    webUrl: "http://localhost:3000",
    status: async () => "setup-required",
    claim: async () => {
      calls++;
      return { replayed: false };
    },
  });
  const request = (body: string, origin = "http://localhost:3000"): Request =>
    new Request("http://localhost:3002/api/instance/setup", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body,
    });
  expect(
    (await handlers.create(request("{}", "http://attacker.test"))).status,
  ).toBe(403);
  expect((await handlers.create(request("{"))).status).toBe(400);
  expect((await handlers.create(request("x".repeat(8193)))).status).toBe(400);
  expect(calls).toBe(0);
  expect((await handlers.create(request("{}"))).status).toBe(201);
  const status = await handlers.status(new Request("http://localhost:3002"));
  expect(await status.json()).toEqual({ status: "setup-required" });
  expect(status.headers.get("cache-control")).toContain("no-store");
});
test("database failure cannot become first-run state and invalid proofs remain rejected", async () => {
  const handlers = createInstanceSetupHandlers({
    webUrl: "http://localhost:3000",
    status: async () => {
      throw new Error("private database details");
    },
    claim: async () => {
      throw new InstanceSetupError(403, "Setup code is invalid.");
    },
  });
  const status = await handlers.status(new Request("http://api.test"));
  expect(status.status).toBe(503);
  expect(await status.text()).not.toContain("private database details");
  const response = await handlers.create(
    new Request("http://api.test", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(response.status).toBe(403);
});
