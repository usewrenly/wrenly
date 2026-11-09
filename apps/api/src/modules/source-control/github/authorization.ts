/**
 * COMPONENT: GitHub browser authorization parameters
 * PURPOSE: Bind a browser round-trip to a local session with unpredictable state and PKCE.
 * INPUTS: Configured web origin and registered GitHub App client ID.
 * OUTPUTS: Callback URL, fresh secrets, state fingerprint and GitHub authorization URL.
 * STEPS: Validate the origin, generate independent random values, hash the verifier, construct fixed URLs.
 * EDGE CASES: Local HTTP is allowed only for loopback development; production needs HTTPS.
 * ERROR STATES: Invalid configuration fails before redirecting; no arbitrary return URL is accepted.
 */
import { createHash, randomBytes } from "node:crypto";
const SECRET_BYTES = 32;
export const SOURCE_AUTH_TTL_MS = 10 * 60 * 1000;
export type SourceAuthorizationPurpose = "register-app" | "connect-account";
export function sourceCallbackUrl(
  origin: string,
  purpose: SourceAuthorizationPurpose,
): string {
  const url = new URL(origin);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "GitHub connection requires HTTPS or a local loopback development origin.",
    );
  return new URL(
    `/api/source/github/${purpose === "register-app" ? "registration" : "authorization"}/callback`,
    url,
  ).href;
}
/** Only this fingerprint is stored in the state column; state itself goes to the initiating browser. */
export function sourceStateHash(state: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state))
    throw new Error("Invalid GitHub authorization state.");
  return createHash("sha256").update(state).digest("hex");
}
export function newSourceAuthorization(): {
  state: string;
  stateHash: string;
  verifier: string;
  challenge: string;
} {
  const state = randomBytes(SECRET_BYTES).toString("base64url");
  const verifier = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    state,
    stateHash: sourceStateHash(state),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}
export function gitHubAuthorizationUrl(input: {
  clientId: string;
  callbackUrl: string;
  state: string;
  challenge: string;
}): string {
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.clientId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)
  )
    throw new Error("Invalid GitHub App authorization settings.");
  sourceStateHash(input.state);
  const callback = new URL(input.callbackUrl);
  if (sourceCallbackUrl(callback.origin, "connect-account") !== callback.href)
    throw new Error("GitHub callback does not match the configured route.");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: callback.href,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}
