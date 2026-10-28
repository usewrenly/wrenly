/**
 * Legacy project recovery HTTP boundary.
 * Every review, confirmation and action lookup requires authenticated owner authority.
 * Bounded bodies and trusted-origin checks precede store operations; loading a review never transfers a project.
 */
import { LegacyRecoveryError } from "./legacy-project-recovery-store";
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "no-store, private" };
export interface LegacyRecoveryHandlers {
  list: (request: Request) => Promise<Response>;
  review: (request: Request) => Promise<Response>;
  confirm: (request: Request) => Promise<Response>;
}
async function readInput(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new LegacyRecoveryError(400, "Send JSON input.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new LegacyRecoveryError(400, "Recovery input is required.");
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, BODY_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > MAX_BODY_BYTES)
        throw new LegacyRecoveryError(400, "Recovery input is too large.");
      chunks.push(next.value);
    }
    if (expired)
      throw new LegacyRecoveryError(400, "Recovery input timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new LegacyRecoveryError(400, "Recovery input is invalid JSON.");
    }
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Binds bounded requests to owner-fenced inventory, review and transfer services. */
export function createLegacyRecoveryHandlers(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  list: (actorId: string) => Promise<unknown>;
  review: (actorId: string, input: unknown) => Promise<unknown>;
  confirm: (actorId: string, input: unknown) => Promise<unknown>;
}): LegacyRecoveryHandlers {
  const handle =
    (kind: "list" | "review" | "confirm") =>
    async (request: Request): Promise<Response> => {
      try {
        if (
          kind !== "list" &&
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          throw new LegacyRecoveryError(
            403,
            "Open recovery from this instance’s trusted web address.",
          );
        const actorId = await dependencies.session(request.headers);
        if (!actorId)
          return Response.json(
            { error: "Sign in before recovering projects." },
            { status: 401, headers: HEADERS },
          );
        const result =
          kind === "list"
            ? await dependencies.list(actorId)
            : await dependencies[kind](actorId, await readInput(request));
        return Response.json(result, { headers: HEADERS });
      } catch (error) {
        if (error instanceof LegacyRecoveryError)
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        return Response.json(
          { error: "Project recovery is unavailable. Try again." },
          { status: 503, headers: HEADERS },
        );
      }
    };
  return {
    list: handle("list"),
    review: handle("review"),
    confirm: handle("confirm"),
  };
}
