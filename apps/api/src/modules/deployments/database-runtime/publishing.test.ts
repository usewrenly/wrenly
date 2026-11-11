import { expect, test } from "bun:test";
import {
  createProductionDeploymentServices,
  assertProductionRuntimeEnvironment,
} from "./publishing";
test("runtime adapter refuses mutable or missing trusted image identities", () => {
  const images = {
    brokerImageId: `sha256:${"a".repeat(64)}`,
    ingressImageId: `sha256:${"b".repeat(64)}`,
    ingressImage: `registry.example.test/wrenly/ingress@sha256:${"c".repeat(64)}`,
  };
  expect(() => createProductionDeploymentServices(images)).not.toThrow();
  for (const invalid of [
    { ...images, ingressImage: "registry.example.test/wrenly/ingress:latest" },
    { ...images, brokerImageId: "wrenly/database-socket:2" },
    { ...images, ingressImageId: "" },
  ])
    expect(() => createProductionDeploymentServices(invalid)).toThrow();
});
test("guardian composition cannot silently drop custom runtime configuration", () => {
  expect(() => assertProductionRuntimeEnvironment("nextjs", {})).not.toThrow();
  expect(() =>
    assertProductionRuntimeEnvironment("nextjs", { API_KEY: "secret" }),
  ).toThrow();
  const laravel = {
    APP_ENV: "production",
    APP_DEBUG: "false",
    LOG_CHANNEL: "stderr",
    SESSION_DRIVER: "file",
    CACHE_STORE: "array",
    QUEUE_CONNECTION: "sync",
    APP_KEY: `base64:${Buffer.alloc(32).toString("base64")}`,
  };
  expect(() =>
    assertProductionRuntimeEnvironment("laravel", laravel),
  ).not.toThrow();
  expect(() =>
    assertProductionRuntimeEnvironment("laravel", {
      ...laravel,
      QUEUE_CONNECTION: "redis",
    }),
  ).toThrow();
  expect(() =>
    assertProductionRuntimeEnvironment("laravel", {
      ...laravel,
      CUSTOM_SECRET: "secret",
    }),
  ).toThrow();
});
