import { expect, test } from "bun:test";
import { validateProductionImageFacts } from "../../src/deployment-runtime/toolchain";
const images = {
  brokerImageId: "sha256:" + "a".repeat(64),
  ingressImageId: "sha256:" + "b".repeat(64),
};
const broker = {
  Id: images.brokerImageId,
  Config: {
    User: "1000:1000",
    Entrypoint: ["bun", "--no-env-file", "/wrenly/entrypoint.ts"],
  },
};
const ingress = {
  Id: images.ingressImageId,
  Config: {
    User: "1000:1000",
    Entrypoint: ["bun", "--no-env-file", "/wrenly/ingress.js"],
    Labels: {
      "io.wrenly.runtime-role": "deployment-ingress",
      "io.wrenly.runtime-version": "1",
    },
  },
};
test("trusted image inspection requires exact pins and fixed toolchain identities", () => {
  expect(() =>
    validateProductionImageFacts(images, broker, ingress),
  ).not.toThrow();
  for (const changed of [
    { ...broker, Id: images.ingressImageId },
    { ...broker, Config: { ...broker.Config, User: "root" } },
    { ...broker, Config: { ...broker.Config, Entrypoint: ["sh"] } },
  ])
    expect(() =>
      validateProductionImageFacts(images, changed, ingress),
    ).toThrow();
  for (const changed of [
    { ...ingress, Id: images.brokerImageId },
    { ...ingress, Config: { ...ingress.Config, User: "root" } },
    { ...ingress, Config: { ...ingress.Config, Labels: {} } },
  ])
    expect(() =>
      validateProductionImageFacts(images, broker, changed),
    ).toThrow();
});
