/**
 * Public instance access summary.
 * Returns display mode and whether supplied headers resolve to a real authenticated identity.
 * A one-person mode never grants anonymous access; errors cannot masquerade as first-run setup.
 */
import { logger } from "../../../lib/logger";

/** Returns public mode and current access only; never exposes session or operator configuration. */
export function createInstanceAccessHandler(dependencies: {
  singleUser: boolean;
  userId: (headers: Headers) => Promise<string | null>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = { "Cache-Control": "no-store, private", Vary: "Cookie" };
    try {
      const id = await dependencies.userId(request.headers);
      return Response.json(
        {
          mode: dependencies.singleUser ? "single-user" : "multi-user",
          access: id ? "authenticated" : "sign-in-required",
        },
        { headers },
      );
    } catch (error) {
      logger.error("Instance access check failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return Response.json(
        { error: "Instance access could not be checked. Try again." },
        { status: 503, headers },
      );
    }
  };
}
