import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  exchangeGitHubAuthorization,
  exchangeGitHubManifest,
} from "../exchange";
const auth = {
  code: "c".repeat(40),
  clientId: "Iv1.fixture",
  clientSecret: "private-client-secret",
  verifier: "v".repeat(43),
  callbackUrl:
    "https://instance.example/api/source/github/authorization/callback",
};
const tokens = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  token_type: "bearer" as const,
  expires_in: 28800,
  refresh_token_expires_in: 15552000,
};
test("user exchange pins destination and sends saved PKCE without redirecting", async () => {
  expect(
    await exchangeGitHubAuthorization(auth, async (url, init) => {
      expect(url.href).toBe("https://github.com/login/oauth/access_token");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(JSON.parse(String(init.body))).toMatchObject({
        code_verifier: auth.verifier,
        redirect_uri: auth.callbackUrl,
        client_secret: auth.clientSecret,
      });
      return Response.json(tokens);
    }),
  ).toEqual(tokens);
});
test("token responses must expire and failures never expose provider bodies", async () => {
  for (const response of [
    { ...tokens, expires_in: 0 },
    { ...tokens, refresh_token: undefined },
    { error: "private-detail" },
  ])
    await expect(
      exchangeGitHubAuthorization(auth, async () => Response.json(response)),
    ).rejects.toThrow("Start a new connection");
  await expect(
    exchangeGitHubAuthorization(
      auth,
      async () => new Response("secret-body", { status: 403 }),
    ),
  ).rejects.toThrow("Start a new connection");
  await expect(
    exchangeGitHubAuthorization(
      auth,
      async () => new Response("x".repeat(40000)),
    ),
  ).rejects.toThrow("Start a new connection");
});
test("manifest exchange accepts only the expected source permission set and a real RSA key", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const app = {
    id: 42,
    slug: "fixture",
    client_id: "Iv1.fixture",
    client_secret: "secret",
    pem: privateKey,
    permissions: { contents: "write", metadata: "read" },
  };
  expect(
    (
      await exchangeGitHubManifest("a".repeat(40), async (url) => {
        expect(url.origin).toBe("https://api.github.com");
        return Response.json(app);
      })
    ).id,
  ).toBe(42);
  for (const changed of [
    { ...app, pem: "not-a-key" },
    { ...app, permissions: { ...app.permissions, actions: "write" } },
  ])
    await expect(
      exchangeGitHubManifest("a".repeat(40), async () =>
        Response.json(changed),
      ),
    ).rejects.toThrow();
});
test("cancellation bounds an unresponsive code exchange", async () => {
  const controller = new AbortController();
  const pending = exchangeGitHubAuthorization(
    auth,
    async () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow("Start a new connection");
});

test("refresh exchange is pinned and sends the single-use refresh grant only", async () => {
  const { exchangeGitHubRefresh } = await import("../exchange");
  let body: unknown;
  const tokens = await exchangeGitHubRefresh(
    {
      clientId: "Iv1.fixture",
      clientSecret: "private-secret",
      refreshToken: "refresh-once",
    },
    async (url, init) => {
      expect(url.href).toBe("https://github.com/login/oauth/access_token");
      body = JSON.parse(String(init.body));
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "bearer",
        expires_in: 28800,
        refresh_token_expires_in: 15552000,
      });
    },
  );
  expect(body).toEqual({
    client_id: "Iv1.fixture",
    client_secret: "private-secret",
    refresh_token: "refresh-once",
    grant_type: "refresh_token",
  });
  expect(tokens.access_token).toBe("new-access");
});
