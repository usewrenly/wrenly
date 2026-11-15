import { expect, test } from "bun:test";
import { createGitHubAppManifest } from "../../src/providers/github/app-manifest";
const input = {
  name: "Wrenly local studio",
  homepage: "http://localhost:3000",
  registrationCallback:
    "http://localhost:3000/api/source/github/registration/callback",
  authorizationCallback:
    "http://localhost:3000/api/source/github/authorization/callback",
};
test("App registration requests only source permissions with no webhooks or central service", () => {
  const manifest = createGitHubAppManifest(input);
  expect(manifest.default_permissions).toEqual({
    contents: "write",
    metadata: "read",
  });
  expect(manifest.default_events).toEqual([]);
  expect(manifest.url).toBe("http://localhost:3000/");
  expect(manifest.hook_attributes).toEqual({
    active: false,
    url: "https://example.com/github/webhook",
  });
  expect(manifest.public).toBe(false);
  expect(manifest.callback_urls).toEqual([input.authorizationCallback]);
});
test("App manifest cannot redirect credentials to a browser-selected host or route", () => {
  for (const change of [
    { homepage: "http://example.com" },
    { homepage: "https://user:secret@localhost:3000" },
    {
      registrationCallback:
        "https://evil.example/api/source/github/registration/callback",
    },
    {
      authorizationCallback: `${input.authorizationCallback}?next=https://evil.example`,
    },
    { name: "<script>" },
  ])
    expect(() => createGitHubAppManifest({ ...input, ...change })).toThrow();
});

test("installation on other accounts requires an explicit owner visibility choice", () => {
  expect(
    createGitHubAppManifest({ ...input, allowOtherAccounts: true }).public,
  ).toBe(true);
  expect(createGitHubAppManifest(input).public).toBe(false);
});


test("disabled webhook never inherits local callbacks or activates delivery", () => {
  for (const homepage of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://wrenly.example.org"]) {
    const manifest = createGitHubAppManifest({ ...input, homepage,
      registrationCallback: `${homepage}/api/source/github/registration/callback`,
      authorizationCallback: `${homepage}/api/source/github/authorization/callback` });
    expect(manifest.hook_attributes).toEqual({active:false,url:"https://example.com/github/webhook"});
    expect(manifest.default_events).toEqual([]);
    expect(new URL(manifest.redirect_url).origin).toBe(homepage);
    expect(new URL(manifest.callback_urls[0]!).origin).toBe(homepage);
  }
});
