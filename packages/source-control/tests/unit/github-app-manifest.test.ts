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
  expect(manifest.hook_attributes.active).toBe(false);
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
