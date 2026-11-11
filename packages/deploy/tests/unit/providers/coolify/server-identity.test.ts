import { expect, test } from "bun:test";
import type { DeploymentProviderClient } from "../../../../src/http/provider-client";
import { readCoolifyServerIdentity } from "../../../../src/providers/coolify/server-identity";
test("server inspection is a fixed read and returns only matching safe facts", async () => {
  const client: DeploymentProviderClient = {
    request: async (method, endpoint, body) => {
      expect([method, endpoint, body]).toEqual([
        "GET",
        "/api/v1/servers/fixture",
        undefined,
      ]);
      return {
        uuid: "fixture",
        ip: "10.20.30.40",
        port: 22,
        settings: { secret: "do-not-return" },
      };
    },
  };
  expect(
    await readCoolifyServerIdentity(
      client,
      "fixture",
      new AbortController().signal,
    ),
  ).toEqual({ uuid: "fixture", address: "10.20.30.40", port: 22 });
});
test("foreign identities, malformed addresses and cancelled reads fail safely", async () => {
  for (const reply of [
    null,
    [],
    { uuid: "foreign", ip: "10.20.30.40", port: 22 },
    { uuid: "fixture", ip: "host/path", port: 22 },
    { uuid: "fixture", ip: "10.20.30.40", port: 0 },
  ]) {
    await expect(
      readCoolifyServerIdentity(
        { request: async () => reply },
        "fixture",
        new AbortController().signal,
      ),
    ).rejects.toThrow("could not be verified");
  }
  await expect(
    readCoolifyServerIdentity(
      {
        request: async () => {
          throw new Error("private detail");
        },
      },
      "fixture",
      new AbortController().signal,
    ),
  ).rejects.toThrow("could not be verified");
});
