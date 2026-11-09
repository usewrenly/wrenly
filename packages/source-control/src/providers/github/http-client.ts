/**
 * COMPONENT: Read-only GitHub API transport
 * PURPOSE: Keep a connection's credential on api.github.com with bounded response work.
 * INPUTS: A server-resolved user token, fixed relative API path and cancellation signal.
 * OUTPUTS: Unknown JSON for a provider decoder, or a fixed error without remote content.
 * STEPS: Validate path, send once without redirects/cookies, bound streamed bytes and parse JSON.
 * EDGE CASES: Abort during body reading, malformed JSON, redirects and rate limits.
 * ERROR STATES: Never retry, return a remote body or follow provider-supplied download URLs.
 */
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_TOKEN_CHARACTERS = 8192;
export class GitHubRequestError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "http_error"
      | "response_limit"
      | "invalid_json"
      | "request_failed",
    public readonly status?: number,
  ) {
    super(`GitHub request failed (${code}).`);
    this.name = "GitHubRequestError";
  }
}
export interface GitHubReadClient {
  get(path: string, signal?: AbortSignal): Promise<unknown>;
}
/** The API must resolve current personal authority before supplying a token to this server-only client. */
function createGitHubTransport(
  token: string,
  transport: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): {
  request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
} {
  if (
    !token ||
    token.length > MAX_TOKEN_CHARACTERS ||
    /[^\x21-\x7e]/.test(token)
  )
    throw new GitHubRequestError("invalid_request");
  return {
    async request(method, path, body, externalSignal): Promise<unknown> {
      if (
        !/^\/(?:user(?:\/|\?|$)|repos\/|repositories\/|user\/installations)/.test(
          path,
        ) ||
        path.length > 2048 ||
        /[\\#\x00-\x20\x7f]/.test(path)
      )
        throw new GitHubRequestError("invalid_request");
      let url: URL;
      try {
        url = new URL(path, API_ORIGIN);
        if (
          url.origin !== API_ORIGIN ||
          path
            .split("?")[0]!
            .split("/")
            .some((part) => {
              const decoded = decodeURIComponent(part);
              return (
                decoded === "." || decoded === ".." || /[\\/]/.test(decoded)
              );
            })
        )
          throw new Error("Unsafe path");
      } catch {
        throw new GitHubRequestError("invalid_request");
      }
      if (
        method === "POST" &&
        !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/git\/(trees|commits|refs)$/.test(
          path,
        )
      )
        throw new GitHubRequestError("invalid_request");
      const serialized = method === "POST" ? JSON.stringify(body) : undefined;
      if (
        method === "POST" &&
        (!serialized || Buffer.byteLength(serialized) > MAX_REQUEST_BYTES)
      )
        throw new GitHubRequestError("invalid_request");
      const signal = AbortSignal.any([
        AbortSignal.timeout(TIMEOUT_MS),
        ...(externalSignal ? [externalSignal] : []),
      ]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new GitHubRequestError("request_failed")),
          { once: true },
        );
      });
      try {
        signal.throwIfAborted();
        const response = await Promise.race([
          transport(url, {
            method,
            body: serialized,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              ...(method === "POST"
                ? { "Content-Type": "application/json" }
                : {}),
              "X-GitHub-Api-Version": API_VERSION,
            },
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal,
          }),
          cancelled,
        ]);
        if (!response.ok || response.redirected) {
          await response.body?.cancel();
          throw new GitHubRequestError("http_error", response.status);
        }
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
        ) {
          await response.body?.cancel();
          throw new GitHubRequestError("response_limit");
        }
        if (!response.body) throw new GitHubRequestError("invalid_json");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await Promise.race([reader.read(), cancelled]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES)
            throw new GitHubRequestError("response_limit");
          chunks.push(chunk.value);
        }
        signal.throwIfAborted();
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
        } catch {
          throw new GitHubRequestError("invalid_json");
        }
      } catch (error) {
        if (error instanceof GitHubRequestError) throw error;
        throw new GitHubRequestError("request_failed");
      } finally {
        if (reader) {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
    },
  };
}

/** Read-only callers never receive a remote mutation method. */
export function createGitHubReadClient(
  token: string,
  transport: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): GitHubReadClient {
  const client = createGitHubTransport(token, transport);
  return {
    get: (path, signal) => client.request("GET", path, undefined, signal),
  };
}
export interface GitHubObjectClient extends GitHubReadClient {
  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
}
/** Only immutable Git objects and new refs can be created; no ref-update or force-push method exists. */
export function createGitHubObjectClient(
  token: string,
  transport: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): GitHubObjectClient {
  const client = createGitHubTransport(token, transport);
  return {
    get: (path, signal) => client.request("GET", path, undefined, signal),
    post: (path, body, signal) => client.request("POST", path, body, signal),
  };
}
