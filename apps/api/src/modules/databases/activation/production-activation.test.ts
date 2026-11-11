/** Activation uses injected lifecycle services so these checks never touch an installation. */
import { expect, test } from "bun:test";
import { db } from "@wrenly/db";
import { parseApiEnvironment } from "../../../config/api-environment";
import { startProductionClusterModule } from "../production-targets/module";
import { startProductionDatabaseActivation } from "./production-activation";
const base = {
  WRENLY_DATABASE_URL: "postgresql://fixture:fixture-only@127.0.0.1:1/fixture",
  WRENLY_AUTH_SECRET: "a".repeat(64),
  WRENLY_APP_URL: "http://localhost:3002",
  WRENLY_WEB_URL: "http://localhost:3000",
};
const environment = parseApiEnvironment({
  ...base,
  WRENLY_PREVIEW_ENABLED: "true",
  WRENLY_APP_DATABASES_ENABLED: "true",
  WRENLY_PUBLISHING_ENABLED: "true",
  WRENLY_PRODUCTION_DATABASES_ENABLED: "true",
  WRENLY_DEPLOY_ENCRYPTION_KEY: "ab".repeat(32),
  WRENLY_REGISTRY_URL: "https://registry.example",
  WRENLY_REGISTRY_USERNAME: "fixture",
  WRENLY_REGISTRY_PASSWORD: "fixture-only",
  WRENLY_GIT_BASE_URL: "https://git.example",
  WRENLY_GIT_TOKEN: "fixture-only",
  WRENLY_COOLIFY_API_URL: "https://coolify.example/api/v1",
  WRENLY_COOLIFY_API_KEY: "fixture-only",
  WRENLY_COOLIFY_PROJECT_UUID: "fixture-project",
  WRENLY_COOLIFY_SERVER_UUID: "fixture-server",
  WRENLY_PRODUCTION_BROKER_IMAGE_ID: "sha256:" + "a".repeat(64),
  WRENLY_PRODUCTION_INGRESS_IMAGE_ID: "sha256:" + "b".repeat(64),
  WRENLY_PRODUCTION_INGRESS_IMAGE:
    "registry.example/wrenly/ingress@sha256:" + "c".repeat(64),
});
const input = { database: db, environment, principal: async () => null };
test("disabled Production starts no worker or trusted-image probe", async () => {
  let calls = 0;
  expect(
    await startProductionDatabaseActivation(
      { ...input, environment: parseApiEnvironment(base) },
      {
        verifyImages: async () => {
          calls++;
        },
        start: async () => {
          calls++;
          throw new Error("must not start");
        },
      },
    ),
  ).toBeUndefined();
  expect(calls).toBe(0);
});
test("a failed trusted-image check starts no Production control work", async () => {
  let starts = 0;
  await expect(
    startProductionDatabaseActivation(input, {
      verifyImages: async () => {
        throw new Error("unverified image");
      },
      start: async () => {
        starts++;
        throw new Error("must not start");
      },
    }),
  ).rejects.toThrow("unverified image");
  expect(starts).toBe(0);
});
test("verified activation returns matching handlers, publishing adapters and one awaited module cleanup", async () => {
  const calls: string[] = [];
  const module = await startProductionDatabaseActivation(input, {
    verifyImages: async (images) => {
      expect(images.brokerImageId).toBe(
        environment.WRENLY_PRODUCTION_BROKER_IMAGE_ID!,
      );
      calls.push("images");
    },
    start: async (configuration) => {
      expect(configuration.controlDatabaseUrl).toBe(base.WRENLY_DATABASE_URL);
      expect(configuration.verifyDeploymentServer).toBeFunction();
      return startProductionClusterModule(configuration, {
        verify: async () => {
          calls.push("schema");
        },
        control: () => {
          calls.push("control");
          return {
            stop: async () => {
              calls.push("stop-control");
            },
          };
        },
        resources: () => {
          calls.push("resources");
          return {
            stop: async () => {
              calls.push("stop-resources");
            },
          };
        },
      });
    },
  });
  expect(calls).toEqual(["images", "schema", "control", "resources"]);
  expect(module?.publishing.production?.prepare).toBeFunction();
  expect(
    (
      await module!.instanceSetup.status(
        new Request("http://localhost:3002/api/instance/production-database"),
      )
    ).status,
  ).toBe(401);
  await module!.stop();
  await module!.stop();
  expect(calls).toEqual([
    "images",
    "schema",
    "control",
    "resources",
    "stop-control",
    "stop-resources",
  ]);
});
