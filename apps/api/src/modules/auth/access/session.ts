/**
 * HTTP session resolution.
 * Reads a Better Auth session and rechecks its live account revision before returning identity.
 * Every installation requires sign-in; configuration never substitutes an anonymous local account.
 * Captures the principal in the request scope for later transactional checks.
 */
import { APIError } from "better-auth/api";
import { db } from "@wrenly/db";
import { readActivePrincipal } from "./access-policy";
import { accessContext } from "./access-context";
import { auth } from "../configuration/auth";

/** Resolves an active authenticated account; legacy single-user configuration never grants access. */
export async function getUserId(
  requestHeaders: Headers,
): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session) return null;
    const principal = await readActivePrincipal(
      db,
      session.user.id,
      session.session.id,
    );
    const context = accessContext.getStore();
    if (principal && context) context.principal = principal;
    return principal?.userId ?? null;
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.statusCode === 401 || error.statusCode === 403)
    )
      return null;
    throw new Error("Session could not be verified.", { cause: error });
  }
}

/**
 * Same as getUserId() but throws if the user is not authenticated.
 * Use in route handlers that must always have a user.
 * Route handlers convert a missing identity into a structured 401 response.
 */
export async function requireUserId(requestHeaders: Headers): Promise<string> {
  const userId = await getUserId(requestHeaders);

  if (!userId) {
    throw new Error("Unauthorized: no valid session found");
  }

  return userId;
}
