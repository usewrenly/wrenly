/**
 * Owner recovery HTTP boundary.
 * Authenticate the selected existing account before accepting a proof; bounded trusted-origin claim handling delegates identity binding and atomic changes to the store.
 */
import { createInstanceSetupHandlers } from "../setup/instance-setup-http";
/** Authenticate before accepting a recovery proof; the store binds it to that exact identity. */
export function createOwnerRecoveryHandler(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  claim: (input: unknown, userId: string) => Promise<{ replayed: boolean }>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const userId = await dependencies.session(request.headers);
      if (!userId)
        return Response.json(
          {
            error:
              "Sign in to the selected existing account before confirming recovery.",
          },
          { status: 401, headers: { "Cache-Control": "no-store, private" } },
        );
      const handlers = createInstanceSetupHandlers({
        webUrl: dependencies.webUrl,
        status: async () => "recovery-required",
        claim: (input) => dependencies.claim(input, userId),
      });
      return await handlers.create(request);
    } catch {
      return Response.json(
        { error: "Owner recovery could not verify your session. Try again." },
        { status: 503, headers: { "Cache-Control": "no-store, private" } },
      );
    }
  };
}
