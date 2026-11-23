import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  sealProductionSetup,
  openProductionSetup,
  productionSetupRequestIdentity,
  type ProductionSetupInput,
} from "./credentials";
const id = (): string => crypto.randomUUID();
function fixture(): {
  input: ProductionSetupInput;
  scope: Parameters<typeof sealProductionSetup>[1];
  key: Buffer;
} {
  const input: ProductionSetupInput = {
    requestId: id(),
    expectedRevision: id(),
    confirmTarget: true,
    target: {
      version: 1,
      environment: "production",
      host: "database.internal.test",
      port: 5432,
      database: "app",
      sslmode: "verify-full",
    },
    credential: { user: "setup_user", password: "private-setup-password" },
    certificateAuthority: "PRIVATE_CA",
  };
  return {
    input,
    scope: {
      id: id(),
      projectId: id(),
      actorId: "owner",
      accessRevision: input.expectedRevision,
      target: input.target,
    },
    key: randomBytes(32),
  };
}
test("encrypts setup credentials and CA without storing plaintext", () => {
  const { input, scope, key } = fixture(),
    sealed = sealProductionSetup(input, scope, key);
  expect(JSON.stringify(sealed)).not.toContain(input.credential.password);
  expect(JSON.stringify(sealed)).not.toContain("PRIVATE_CA");
  expect(openProductionSetup(sealed, scope, key)).toEqual({
    credential: input.credential,
    certificateAuthority: "PRIVATE_CA",
  });
});
test("owner, project, revision, setup and destination substitution fail", () => {
  const { input, scope, key } = fixture(),
    sealed = sealProductionSetup(input, scope, key);
  for (const changed of [
    { ...scope, id: id() },
    { ...scope, projectId: id() },
    { ...scope, actorId: "another" },
    { ...scope, accessRevision: id() },
    { ...scope, target: { ...scope.target, host: "other.internal.test" } },
  ])
    expect(() => openProductionSetup(sealed, changed, key)).toThrow();
  expect(() => openProductionSetup(sealed, scope, randomBytes(32))).toThrow();
});
test("request HMAC changes with credentials/key and identical input replays", () => {
  const { input, scope, key } = fixture(),
    identity = productionSetupRequestIdentity(
      scope.projectId,
      scope.actorId,
      input,
      key,
    );
  expect(identity).toBe(
    productionSetupRequestIdentity(scope.projectId, scope.actorId, input, key),
  );
  expect(identity).not.toBe(
    productionSetupRequestIdentity(
      scope.projectId,
      scope.actorId,
      { ...input, credential: { ...input.credential, password: "changed" } },
      key,
    ),
  );
  expect(identity).not.toBe(
    productionSetupRequestIdentity(
      scope.projectId,
      scope.actorId,
      input,
      randomBytes(32),
    ),
  );
});
