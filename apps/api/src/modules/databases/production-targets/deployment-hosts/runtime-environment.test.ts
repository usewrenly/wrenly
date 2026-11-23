import { expect, test } from "bun:test";
import { matchesRuntimeEnvironment } from "./runtime-environment";
const deploymentId = "182ba85e-2292-4d64-b519-6b414b8e20d0";
const labels = { "coolify.serviceUuid": "fixture-service" };
const image = ["PATH=/usr/bin", "NODE_ENV=production"];
function metadata(service: "application" | "ingress"): string[] {
  return [
    "COOLIFY_RESOURCE_UUID=fixture-service",
    `COOLIFY_CONTAINER_NAME=${service}-fixture-service`,
    `COOLIFY_APP_NAME=wrenly-${deploymentId}`,
    "SERVICE_NAME_APPLICATION=application", "SERVICE_NAME_INGRESS=ingress",
    "COOLIFY_PROJECT_NAME=Example project", "COOLIFY_ENVIRONMENT_NAME=production",
    "COOLIFY_SERVER_IP=10.0.2.15",
  ];
}
test("accepts unchanged native images and complete Coolify metadata in any order", () => {
  expect(matchesRuntimeEnvironment(image, image, {}, deploymentId, "application")).toBe(true);
  for (const service of ["application", "ingress"] as const) {
    expect(matchesRuntimeEnvironment([...metadata(service), ...image].reverse(), image, labels, deploymentId, service)).toBe(true);
  }
});
test("rejects every partial metadata set and changed fixed identity", () => {
  const fields = metadata("application");
  for (let index = 0; index < fields.length; index++) {
    expect(matchesRuntimeEnvironment([...image, ...fields.filter((_, i) => i !== index)], image, labels, deploymentId, "application")).toBe(false);
  }
  for (const field of fields.slice(0, 5)) {
    expect(matchesRuntimeEnvironment([...image, ...fields.map(value => value === field ? `${value}-changed` : value)], image, labels, deploymentId, "application")).toBe(false);
  }
});
test("rejects credentials, executable overrides, duplicates, malformed keys and arbitrary hosts", () => {
  const valid = [...image, ...metadata("application")];
  for (const addition of ["DATABASE_URL=secret", "NODE_OPTIONS=--require=/tmp/code", "COOLIFY_UNKNOWN=value", "PATH=/other", "=bad", "BAD-KEY=value"]) {
    expect(matchesRuntimeEnvironment([...valid, addition], image, labels, deploymentId, "application")).toBe(false);
  }
  expect(matchesRuntimeEnvironment(valid, image, {}, deploymentId, "application")).toBe(false);
  expect(matchesRuntimeEnvironment(valid.map(value => value.startsWith("COOLIFY_SERVER_IP=") ? "COOLIFY_SERVER_IP=example.com" : value), image, labels, deploymentId, "application")).toBe(false);
  expect(matchesRuntimeEnvironment(valid.map(value => value.startsWith("COOLIFY_PROJECT_NAME=") ? "COOLIFY_PROJECT_NAME=bad\nname" : value), image, labels, deploymentId, "application")).toBe(false);
  expect(matchesRuntimeEnvironment(valid.filter(value => value !== image[0]), image, labels, deploymentId, "application")).toBe(false);
});
