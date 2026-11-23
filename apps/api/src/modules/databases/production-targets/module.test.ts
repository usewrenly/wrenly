import { expect, test } from "bun:test";
import { db } from "@wrenly/db";
import { startProductionClusterModule } from "./module";
const configuration = {
  database: db,
  directory: "/tmp/unused-production-module-fixture",
  controlDatabaseUrl: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
  webUrl: "http://localhost:3000",
  principal: async () => null,
  verifyDeploymentServer: async () => {},
};
test("missing Production prerequisites start no worker", async () => {
  const calls: string[] = [];
  await expect(
    startProductionClusterModule(configuration, {
      verify: async () => {
        calls.push("verify");
        throw new Error("missing migrations");
      },
      control: () => {
        calls.push("control");
        return { stop: async () => {} };
      },
      resources: () => {
        calls.push("resources");
        return { stop: async () => {} };
      },
    }),
  ).rejects.toThrow("missing migrations");
  expect(calls).toEqual(["verify"]);
});
test("partial Production startup awaits the control worker cleanup", async () => {
  let cleanupFinished = false;
  await expect(
    startProductionClusterModule(configuration, {
      verify: async () => {},
      control: () => ({
        stop: async () => {
          await Bun.sleep(5);
          cleanupFinished = true;
        },
      }),
      resources: () => {
        throw new Error("resource startup failed");
      },
    }),
  ).rejects.toThrow("resource startup failed");
  expect(cleanupFinished).toBe(true);
});
test("Production shutdown awaits both workers once and retains cleanup failures", async () => {
  let controls = 0,
    resources = 0;
  const module = await startProductionClusterModule(configuration, {
    verify: async () => {},
    control: () => ({
      stop: async () => {
        controls++;
      },
    }),
    resources: () => ({
      stop: async () => {
        resources++;
        throw new Error("cleanup unconfirmed");
      },
    }),
  });
  await expect(module.stop()).rejects.toThrow("cleanup could not be confirmed");
  await expect(module.stop()).rejects.toThrow("cleanup could not be confirmed");
  expect([controls, resources]).toEqual([1, 1]);
});
