import { expect, test } from "bun:test";
import { ProductionRuntimeHostInput } from "@wrenly/db/production-host-contract";
import {
  sealRuntimeHostCredential,
  openRuntimeHostCredential,
  runtimeHostRequestIdentity,
} from "./credentials";
const key = Buffer.alloc(32, 7);
const input = ProductionRuntimeHostInput.parse({
  requestId: crypto.randomUUID(),
  expectedConnectionId: null,
  confirmTarget: true,
  serverId: "coolify-fixture",
  target: {
    host: "deploy.internal.test",
    port: 22,
    user: "wrenly",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
  },
  privateKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only\n-----END OPENSSH PRIVATE KEY-----\n",
});
const scope = {
  id: crypto.randomUUID(),
  actorId: "owner-fixture",
  serverId: input.serverId,
  target: input.target,
};
test("host keys cannot be moved between owners, connections, servers or destinations", () => {
  const sealed = sealRuntimeHostCredential(input, scope, key);
  expect(JSON.stringify(sealed)).not.toContain("fixture-only");
  expect(openRuntimeHostCredential(sealed, scope, key)).toBe(input.privateKey);
  for (const changed of [
    { ...scope, id: crypto.randomUUID() },
    { ...scope, actorId: "another" },
    { ...scope, serverId: "another" },
    { ...scope, target: { ...scope.target, port: 2222 } },
  ])
    expect(() => openRuntimeHostCredential(sealed, changed, key)).toThrow();
  expect(() =>
    openRuntimeHostCredential(sealed, scope, Buffer.alloc(32, 8)),
  ).toThrow();
  expect(() =>
    sealRuntimeHostCredential(input, { ...scope, serverId: "another" }, key),
  ).toThrow();
});
test("request replay includes reviewed destination, predecessor and credential", () => {
  const identity = runtimeHostRequestIdentity(input, scope.actorId, key);
  expect(runtimeHostRequestIdentity({ ...input }, scope.actorId, key)).toBe(
    identity,
  );
  for (const changed of [
    { ...input, expectedConnectionId: crypto.randomUUID() },
    { ...input, serverId: "another" },
    {
      ...input,
      privateKey: input.privateKey.replace("fixture-only", "different"),
    },
  ])
    expect(runtimeHostRequestIdentity(changed, scope.actorId, key)).not.toBe(
      identity,
    );
  expect(runtimeHostRequestIdentity(input, "another", key)).not.toBe(identity);
  expect(() =>
    ProductionRuntimeHostInput.parse({ ...input, command: "exec" }),
  ).toThrow();
});
