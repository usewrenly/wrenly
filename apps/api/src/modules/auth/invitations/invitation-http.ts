/**
 * Invitation HTTP boundary.
 * Owner administration and proof-bearing inspection/acceptance are separate operations.
 * Reads bounded bodies and delegates authorization/atomic changes to the store; never accepts browser-declared organization authority.
 */
import { InvitationError } from "./invitation-store";
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "no-store, private" };
type Operation =
  "list" | "initialize" | "issue" | "revoke" | "inspect" | "accept";
export type InvitationHandlers = Record<
  Operation,
  (request: Request) => Promise<Response>
>;
async function readInput(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new InvitationError(400, "Send JSON input.");
  const reader = request.body?.getReader();
  if (!reader) throw new InvitationError(400, "Invitation input is required.");
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
        throw new InvitationError(400, "Invitation input is too large.");
      chunks.push(next.value);
    }
    if (expired) throw new InvitationError(400, "Invitation input timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new InvitationError(400, "Invitation input is invalid JSON.");
    }
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Enforces browser origin/body limits while services enforce owner and proof bindings. */
export function createInvitationHandlers(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  list: (actorId: string) => Promise<unknown>;
  initialize: (actorId: string) => Promise<void>;
  issue: (
    actorId: string,
    headers: Headers,
    input: unknown,
  ) => Promise<unknown>;
  revoke: (actorId: string, headers: Headers, input: unknown) => Promise<void>;
  inspect: (input: unknown) => Promise<unknown>;
  accept: (headers: Headers, input: unknown) => Promise<unknown>;
}): InvitationHandlers {
  const handle =
    (kind: Operation) =>
    async (request: Request): Promise<Response> => {
      try {
        if (
          kind !== "list" &&
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          throw new InvitationError(
            403,
            "Open invitations from this instance’s trusted web address.",
          );
        let actorId: string | null = null;
        if (kind !== "inspect" && kind !== "accept") {
          actorId = await dependencies.session(request.headers);
          if (!actorId)
            throw new InvitationError(
              401,
              "Sign in before managing instance access.",
            );
        }
        const input = kind === "list" ? null : await readInput(request);
        let result: unknown;
        switch (kind) {
          case "list":
            result = await dependencies.list(actorId!);
            break;
          case "initialize":
            await dependencies.initialize(actorId!);
            result = { initialized: true };
            break;
          case "issue":
            result = await dependencies.issue(actorId!, request.headers, input);
            break;
          case "revoke":
            await dependencies.revoke(actorId!, request.headers, input);
            result = { revoked: true };
            break;
          case "inspect":
            result = await dependencies.inspect(input);
            break;
          case "accept":
            result = await dependencies.accept(request.headers, input);
            break;
        }
        return Response.json(result, { headers: HEADERS });
      } catch (error) {
        if (error instanceof InvitationError)
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        return Response.json(
          { error: "Instance invitations are unavailable. Try again." },
          { status: 503, headers: HEADERS },
        );
      }
    };
  return {
    list: handle("list"),
    initialize: handle("initialize"),
    issue: handle("issue"),
    revoke: handle("revoke"),
    inspect: handle("inspect"),
    accept: handle("accept"),
  };
}
