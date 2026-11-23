import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  sourceCallbackUrl,
  sourceStateHash,
  newSourceAuthorization,
  gitHubAuthorizationUrl,
} from "../authorization";
import {
  encryptSourceCredential,
  decryptSourceCredential,
} from "../credentials";
test("authorization uses independent random state and PKCE and fixed callback routes", () => {
  const auth = newSourceAuthorization(),
    second = newSourceAuthorization();
  expect(auth.state).not.toBe(auth.verifier);
  expect(auth.state).not.toBe(second.state);
  expect(auth.stateHash).toBe(sourceStateHash(auth.state));
  expect(auth.challenge).toBe(
    createHash("sha256").update(auth.verifier).digest("base64url"),
  );
  const callbackUrl = sourceCallbackUrl(
    "http://localhost:3000",
    "connect-account",
  );
  const url = new URL(
    gitHubAuthorizationUrl({ clientId: "Iv1.fixture", callbackUrl, ...auth }),
  );
  expect(url.origin).toBe("https://github.com");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.has("code_verifier")).toBe(false);
  for (const origin of [
    "http://server.example",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?next=evil",
  ])
    expect(() => sourceCallbackUrl(origin, "connect-account")).toThrow();
  expect(() =>
    gitHubAuthorizationUrl({
      clientId: "fixture",
      callbackUrl: "https://evil.test/other",
      ...auth,
    }),
  ).toThrow();
});
test("encrypted credentials cannot cross users, connection versions or purposes", () => {
  const key = randomBytes(32),
    scope = { kind: "user" as const, id: crypto.randomUUID(), userId: "alice" };
  const value = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
  };
  const envelope = encryptSourceCredential(value, key, scope);
  expect(JSON.stringify(envelope)).not.toContain("access-secret");
  expect(decryptSourceCredential(envelope, key, scope)).toEqual(value);
  for (const changed of [
    { ...scope, userId: "bob" },
    { ...scope, id: crypto.randomUUID() },
    { ...scope, kind: "app" as const },
  ])
    expect(() => decryptSourceCredential(envelope, key, changed)).toThrow();
  expect(() =>
    decryptSourceCredential(envelope, randomBytes(32), scope),
  ).toThrow();
  expect(() =>
    encryptSourceCredential({ ...value, unexpected: "secret" }, key, scope),
  ).toThrow();
});
