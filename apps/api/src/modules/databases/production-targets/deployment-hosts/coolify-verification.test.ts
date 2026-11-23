import { expect, test } from "bun:test";
import { createCoolifyHostVerifier } from "./coolify-verification";
const target = {
  host: "deploy.internal.test",
  port: 22,
  user: "wrenly",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
};
const identity = {
  version: 1 as const,
  nonce: crypto.randomUUID(),
  dockerId: "fixture-daemon",
  operatingSystem: "linux" as const,
  architecture: "x86_64" as const,
  helperVersion: 1 as const,
};
function verifier(reply: unknown, addresses = ["10.20.30.40"]) {
  return createCoolifyHostVerifier({
    origin: "https://coolify.internal.test",
    token: "fixture-token",
    serverId: "fixture",
    lookup: async () => addresses.map((address) => ({ address, family: 4 })),
    transport: Object.assign(async () => Response.json(reply), {
      preconnect: (): void => {},
    }),
  });
}
test("reviewed hostname and selected pinned address match the configured server", async () => {
  for (const ip of [target.host, "10.20.30.40"]) {
    await verifier({ uuid: "fixture", ip, port: 22 })(
      "fixture",
      identity,
      target,
      ["10.20.30.40"],
      new AbortController().signal,
    );
  }
  expect(true).toBe(true);
});
test("foreign placement, SSH port and private DNS changes fail closed", async () => {
  for (const reply of [
    { uuid: "fixture", ip: "10.20.30.41", port: 22 },
    { uuid: "fixture", ip: target.host, port: 2222 },
    { uuid: "foreign", ip: target.host, port: 22 },
  ])
    await expect(
      verifier(reply)(
        "fixture",
        identity,
        target,
        ["10.20.30.40"],
        new AbortController().signal,
      ),
    ).rejects.toThrow("does not match");
  await expect(
    verifier({ uuid: "fixture", ip: target.host, port: 22 }, ["10.20.30.41"])(
      "fixture",
      identity,
      target,
      ["10.20.30.40"],
      new AbortController().signal,
    ),
  ).rejects.toThrow("does not match");
  await expect(
    verifier({ uuid: "fixture", ip: target.host, port: 22 })(
      "another",
      identity,
      target,
      ["10.20.30.40"],
      new AbortController().signal,
    ),
  ).rejects.toThrow("does not match");
});
