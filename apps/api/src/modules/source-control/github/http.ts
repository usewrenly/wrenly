/** Authenticated source connection endpoints. Callback state replaces Origin checks only on GitHub's browser return. */
import { z } from "zod";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { SourceConnectionError } from "./authorization-store";
import { AccessDeniedError } from "../../auth/access/access-policy";
const MAX_BODY_BYTES = 2048;
const BODY_TIMEOUT_MS = 5000;
const PRIVATE = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie",
};
const Start = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("register"), name: z.string().min(3).max(80) })
    .strict(),
  z.object({ action: z.literal("connect") }).strict(),
]);
export interface GitHubConnectionService {
  prepareImport?(
    principal: AccessPrincipal,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  confirmImport?(principal: AccessPrincipal, raw: unknown): Promise<unknown>;
  status(principal: AccessPrincipal): Promise<unknown>;
  begin(
    principal: AccessPrincipal,
    input: z.infer<typeof Start>,
  ): Promise<unknown>;
  complete(
    principal: AccessPrincipal,
    purpose: "register-app" | "connect-account",
    state: string,
    code: string,
    signal: AbortSignal,
  ): Promise<void>;
  disconnect(principal: AccessPrincipal, version: string): Promise<void>;
  repositories(
    principal: AccessPrincipal,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface GitHubConnectionHandlers {
  prepareImport(request: Request): Promise<Response>;
  confirmImport(request: Request): Promise<Response>;
  status(request: Request): Promise<Response>;
  start(request: Request): Promise<Response>;
  registrationCallback(request: Request): Promise<Response>;
  authorizationCallback(request: Request): Promise<Response>;
  disconnect(request: Request): Promise<Response>;
  repositories(request: Request): Promise<Response>;
}
async function json(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new SourceConnectionError(400, "Send JSON connection settings.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new SourceConnectionError(400, "Connection settings are required.");
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, BODY_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if ((size += part.value.length) > MAX_BODY_BYTES)
        throw new SourceConnectionError(
          400,
          "Connection settings are too large.",
        );
      chunks.push(part.value);
    }
    if (expired)
      throw new SourceConnectionError(400, "Connection request timed out.");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof SourceConnectionError) throw error;
    throw new SourceConnectionError(400, "Send valid connection settings.");
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** Session is resolved before parsing bodies or contacting GitHub. No request may select another local account. */
export function createGitHubConnectionHandlers(options: {
  webUrl: string;
  principal(headers: Headers): Promise<AccessPrincipal | null>;
  service: GitHubConnectionService;
}): GitHubConnectionHandlers {
  const origin = new URL(options.webUrl).origin;
  async function boundary(
    request: Request,
    write: boolean,
    run: (principal: AccessPrincipal) => Promise<unknown>,
  ): Promise<Response> {
    try {
      const principal = await options.principal(request.headers);
      if (!principal)
        return Response.json(
          { error: "Sign in to connect GitHub." },
          { status: 401, headers: PRIVATE },
        );
      if (write && request.headers.get("origin") !== origin)
        return Response.json(
          { error: "Use this instance to change connections." },
          { status: 403, headers: PRIVATE },
        );
      return Response.json(await run(principal), { headers: PRIVATE });
    } catch (error) {
      const denied = error instanceof AccessDeniedError;
      const status =
        error instanceof SourceConnectionError
          ? error.status
          : denied
            ? 403
            : 503;
      return Response.json(
        {
          error:
            error instanceof SourceConnectionError
              ? error.message
              : denied
                ? "Your access changed. Sign in again."
                : "GitHub connection could not be completed. Reload its status before starting again.",
        },
        { status, headers: PRIVATE },
      );
    }
  }
  async function callback(
    request: Request,
    purpose: "register-app" | "connect-account",
  ): Promise<Response> {
    let outcome = "failed";
    try {
      const principal = await options.principal(request.headers),
        query = new URL(request.url).searchParams;
      if (
        !principal ||
        query.getAll("state").length !== 1 ||
        query.getAll("code").length !== 1 ||
        query.has("error")
      )
        throw new Error("Invalid callback");
      const state = query.get("state")!,
        code = query.get("code")!;
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(code)
      )
        throw new Error("Invalid callback");
      await options.service.complete(
        principal,
        purpose,
        state,
        code,
        request.signal,
      );
      outcome = purpose === "register-app" ? "registered" : "connected";
    } catch {
      /* Codes and provider errors are intentionally absent from the redirect and logs. */
    }
    return new Response(null, {
      status: 303,
      headers: {
        ...PRIVATE,
        Location: `${origin}/settings/connections?github=${outcome}`,
      },
    });
  }
  return {
    prepareImport: (request) =>
      boundary(request, true, async (principal) => {
        if (!options.service.prepareImport)
          throw new SourceConnectionError(503, "Source import is unavailable.");
        return options.service.prepareImport(
          principal,
          await json(request),
          request.signal,
        );
      }),
    confirmImport: (request) =>
      boundary(request, true, async (principal) => {
        if (!options.service.confirmImport)
          throw new SourceConnectionError(503, "Source import is unavailable.");
        return options.service.confirmImport(principal, await json(request));
      }),
    status: (request) =>
      boundary(request, false, (p) => options.service.status(p)),
    repositories: (request) =>
      boundary(request, false, (p) =>
        options.service.repositories(p, request.signal),
      ),
    start: (request) =>
      boundary(request, true, async (p) => {
        const input = Start.safeParse(await json(request));
        if (!input.success)
          throw new SourceConnectionError(
            400,
            "Choose registration or account connection.",
          );
        return await options.service.begin(p, input.data);
      }),
    disconnect: (request) =>
      boundary(request, true, async (p) => {
        const input = z
          .object({ version: z.string().uuid() })
          .strict()
          .safeParse(await json(request));
        if (!input.success)
          throw new SourceConnectionError(
            400,
            "Review the current connection before disconnecting.",
          );
        await options.service.disconnect(p, input.data.version);
        return { disconnected: true };
      }),
    registrationCallback: (request) => callback(request, "register-app"),
    authorizationCallback: (request) => callback(request, "connect-account"),
  };
}
