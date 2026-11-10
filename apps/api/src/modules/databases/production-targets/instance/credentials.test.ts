/** Connection secrets cannot be moved to another owner, target or saved connection. */
import { expect, test } from "bun:test";
import {
  ProductionConnectionInput,
  productionConnectionRequestIdentity,
  sealProductionConnection,
  openProductionConnection,
} from "./credentials";
const key = Buffer.alloc(32, 7);
const input = ProductionConnectionInput.parse({
  requestId: crypto.randomUUID(),
  expectedConnectionId: null,
  confirmTarget: true,
  target: {
    version: 1,
    environment: "production",
    host: "apps.internal.test",
    port: 5432,
    database: "maintenance",
    sslmode: "verify-full",
  },
  credential: { user: "postgres", password: "fixture-secret" },
  certificateAuthority: "fixture-ca",
});
const scope = {
  id: crypto.randomUUID(),
  actorId: "owner-fixture",
  target: input.target,
};
test("instance setup is project-independent and encrypts management credentials", () => {
  const sealed = sealProductionConnection(input, scope, key);
  expect(JSON.stringify(sealed)).not.toContain("fixture-secret");
  expect(openProductionConnection(sealed, scope, key)).toEqual({
    credential: input.credential,
    certificateAuthority: input.certificateAuthority,
  });
  for (const changed of [
    { ...scope, id: crypto.randomUUID() },
    { ...scope, actorId: "other-owner" },
    { ...scope, target: { ...scope.target, host: "other.internal.test" } },
  ])
    expect(() => openProductionConnection(sealed, changed, key)).toThrow();
  expect(() =>
    openProductionConnection(sealed, scope, Buffer.alloc(32, 8)),
  ).toThrow();
});
test("replay identity binds passwords, owner and expected connection", () => {
  const identity = productionConnectionRequestIdentity(
    input,
    scope.actorId,
    key,
  );
  expect(
    productionConnectionRequestIdentity({ ...input }, scope.actorId, key),
  ).toBe(identity);
  expect(
    productionConnectionRequestIdentity(input, "other-owner", key),
  ).not.toBe(identity);
  expect(
    productionConnectionRequestIdentity(
      { ...input, credential: { ...input.credential, password: "changed" } },
      scope.actorId,
      key,
    ),
  ).not.toBe(identity);
  expect(
    productionConnectionRequestIdentity(
      { ...input, expectedConnectionId: crypto.randomUUID() },
      scope.actorId,
      key,
    ),
  ).not.toBe(identity);
  expect(() =>
    ProductionConnectionInput.parse({
      ...input,
      projectId: crypto.randomUUID(),
    }),
  ).toThrow();
});
