/**
 * Member administration HTTP boundary.
 * Accepts bounded explicit actions with authenticated identity and delegates owner authorization, action replay and transactional changes to the store.
 * Browser-provided roles never establish authority.
 */
import { MemberAccessError } from "./member-access-store";
const INPUT_TIMEOUT_MS = 5000;
const MAX_INPUT_BYTES = 4096;
export interface MemberAccessHandlers {
  change: (request: Request) => Promise<Response>;
  status: (request: Request, id: string) => Promise<Response>;
}
/** Checks session/origin and bounds management input before the transactional service. */
export function createMemberAccessHandlers(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  change: (
    actorId: string,
    headers: Headers,
    input: unknown,
  ) => Promise<unknown>;
  status: (actorId: string, id: string) => Promise<unknown>;
}): MemberAccessHandlers {
  const handle =
    (mutation: boolean) =>
    async (request: Request, id?: string): Promise<Response> => {
      const headers = { "Cache-Control": "no-store, private" };
      try {
        if (
          mutation &&
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          throw new MemberAccessError(
            403,
            "Use this instance’s trusted web address.",
          );
        const actor = await dependencies.session(request.headers);
        if (!actor)
          throw new MemberAccessError(401, "Sign in before managing members.");
        let input: unknown;
        if (mutation) {
          if (
            request.headers.get("content-type")?.split(";")[0] !==
            "application/json"
          )
            throw new MemberAccessError(400, "Send JSON input.");
          const reader = request.body?.getReader();
          if (!reader)
            throw new MemberAccessError(400, "Provide an access action.");
          const chunks: Uint8Array[] = [];
          let size = 0,
            expired = false;
          const timer = setTimeout(() => {
            expired = true;
            void reader.cancel().catch(() => {});
          }, INPUT_TIMEOUT_MS);
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.length;
              if (size > MAX_INPUT_BYTES)
                throw new MemberAccessError(400, "Access action is too large.");
              chunks.push(next.value);
            }
            if (expired)
              throw new MemberAccessError(400, "Access action timed out.");
            try {
              input = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
            } catch {
              throw new MemberAccessError(400, "Invalid access action.");
            }
          } finally {
            clearTimeout(timer);
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        return Response.json(
          mutation
            ? await dependencies.change(actor, request.headers, input)
            : await dependencies.status(actor, id!),
          { headers },
        );
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof MemberAccessError
                ? error.message
                : "Member access could not be confirmed. Check the saved status.",
          },
          {
            status: error instanceof MemberAccessError ? error.status : 503,
            headers,
          },
        );
      }
    };
  return {
    change: handle(true),
    status: (request, id) => handle(false)(request, id),
  };
}
