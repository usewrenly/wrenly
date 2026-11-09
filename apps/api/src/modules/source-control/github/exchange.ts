/**
 * GitHub's one-time code exchanges. Destinations are fixed; responses and deadlines are bounded.
 * A consumed authorization is never retried here. Errors contain no code, token or provider body.
 */
import { z } from "zod";
import { createPrivateKey } from "node:crypto";
const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 32 * 1024;
type Transport = (url: URL, init: RequestInit) => Promise<Response>;
export class GitHubExchangeError extends Error {
  constructor() {
    super(
      "GitHub authorization could not be completed. Start a new connection.",
    );
    this.name = "GitHubExchangeError";
  }
}
const App = z.object({
  id: z.number().int().positive().safe(),
  slug: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  client_id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  client_secret: z.string().min(1).max(1024),
  pem: z.string().min(1).max(6000),
  permissions: z
    .object({ contents: z.literal("write"), metadata: z.literal("read") })
    .strict(),
});
const Token = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]{1,2048}$/),
  token_type: z.literal("bearer"),
  refresh_token: z.string().regex(/^[\x21-\x7e]{1,2048}$/),
  expires_in: z.number().int().positive().max(86400),
  refresh_token_expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
});
export type GitHubAppExchange = z.infer<typeof App>;
export type GitHubTokenExchange = z.infer<typeof Token>;
async function exchange(
  url: URL,
  body: unknown,
  transport: Transport,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(externalSignal ? [externalSignal] : []),
  ]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new GitHubExchangeError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const pending = transport(url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
    // A transport that ignores cancellation must not retain an unread late response.
    void pending.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await Promise.race([pending, cancelled]);
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new GitHubExchangeError();
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
    ) {
      void response.body.cancel().catch(() => undefined);
      throw new GitHubExchangeError();
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), cancelled]);
      if (chunk.done) break;
      if ((size += chunk.value.length) > MAX_RESPONSE_BYTES)
        throw new GitHubExchangeError();
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new GitHubExchangeError();
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
/** Converts only GitHub's one-time manifest code; no owner-supplied API destination is accepted. */
export async function exchangeGitHubManifest(
  code: string,
  transport: Transport = fetch,
  signal?: AbortSignal,
): Promise<GitHubAppExchange> {
  try {
    if (!/^[a-f0-9]{40,64}$/.test(code)) throw new GitHubExchangeError();
    const app = App.parse(
      await exchange(
        new URL(`https://api.github.com/app-manifests/${code}/conversions`),
        {},
        transport,
        signal,
      ),
    );
    const key = createPrivateKey(app.pem);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new GitHubExchangeError();
    return app;
  } catch {
    throw new GitHubExchangeError();
  }
}
/** PKCE and exact redirect identity must come from a consumed server-side authorization claim. */
export async function exchangeGitHubAuthorization(
  input: {
    code: string;
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    verifier: string;
  },
  transport: Transport = fetch,
  signal?: AbortSignal,
): Promise<GitHubTokenExchange> {
  try {
    if (
      !/^[A-Za-z0-9_-]{16,256}$/.test(input.code) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(input.clientId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.verifier) ||
      !input.clientSecret ||
      input.clientSecret.length > 1024
    )
      throw new GitHubExchangeError();
    return Token.parse(
      await exchange(
        new URL("https://github.com/login/oauth/access_token"),
        {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          redirect_uri: input.callbackUrl,
          code_verifier: input.verifier,
        },
        transport,
        signal,
      ),
    );
  } catch {
    throw new GitHubExchangeError();
  }
}
