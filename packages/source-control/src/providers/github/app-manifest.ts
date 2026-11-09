/** Browser App registration payload; fixed permissions and routes are supplied by Wrenly, not the browser. */
export interface GitHubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  public: false;
  hook_attributes: { active: false };
  default_permissions: { contents: "write"; metadata: "read" };
  default_events: [];
}
/** The instance owner registers their own App, avoiding any central Wrenly credential or service. */
export function createGitHubAppManifest(input: {
  name: string;
  homepage: string;
  registrationCallback: string;
  authorizationCallback: string;
}): GitHubAppManifest {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{2,79}$/.test(input.name))
    throw new Error("Choose a GitHub App name between 3 and 80 characters.");
  const home = new URL(input.homepage),
    registration = new URL(input.registrationCallback),
    authorization = new URL(input.authorizationCallback);
  if (
    !["https:", "http:"].includes(home.protocol) ||
    home.username ||
    home.password ||
    home.pathname !== "/" ||
    home.search ||
    home.hash ||
    (home.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(home.hostname)) ||
    registration.username ||
    registration.password ||
    authorization.username ||
    authorization.password ||
    registration.origin !== home.origin ||
    authorization.origin !== home.origin ||
    registration.pathname !== "/api/source/github/registration/callback" ||
    authorization.pathname !== "/api/source/github/authorization/callback" ||
    registration.search ||
    registration.hash ||
    authorization.search ||
    authorization.hash
  )
    throw new Error(
      "GitHub App callbacks must match this instance’s configured address.",
    );
  return {
    name: input.name,
    url: home.href,
    redirect_url: registration.href,
    callback_urls: [authorization.href],
    public: false,
    hook_attributes: { active: false },
    default_permissions: { contents: "write", metadata: "read" },
    default_events: [],
  };
}
