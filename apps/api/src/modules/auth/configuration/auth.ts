/**
 * Public Better Auth configuration.
 * Mounted by the production API for normal sign-in, sign-out and permitted account operations.
 * Public signup and native organization/admin operations stay closed; protected Wrenly flows use separate transaction-bound SDKs.
 * Live account/session revision checks reject stale authority.
 */
import {
  accessSessionHooks,
  ACCESS_USER_FIELDS,
  ACCESS_SESSION_FIELDS,
  readActivePrincipal,
} from "../access/access-policy";
import { ProfileUpdateSchema } from "../profile/profile-policy";
import { admin, organization as organizationPlugin } from "better-auth/plugins";
import {
  createAuthMiddleware,
  APIError,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { INSTANCE_ORGANIZATION_OPTIONS } from "./organization-options";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  db,
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
} from "@wrenly/db";

// Validate required environment variables at import time.
// Fail loudly at startup rather than silently at runtime.
const secret = process.env.WRENLY_AUTH_SECRET;
const appUrl = process.env.WRENLY_APP_URL;

if (!secret) {
  throw new Error(
    "WRENLY_AUTH_SECRET is not set. " +
      "Generate one with: openssl rand -base64 32",
  );
}

if (!appUrl) {
  throw new Error(
    "WRENLY_APP_URL is not set. " +
      "Set it to the URL of apps/api (e.g. http://localhost:3002)",
  );
}

export const auth = betterAuth({
  plugins: [
    organizationPlugin(INSTANCE_ORGANIZATION_OPTIONS),
    admin({
      bannedUserMessage:
        "Your instance access is suspended. Contact the instance owner.",
    }),
  ],
  user: { additionalFields: ACCESS_USER_FIELDS },
  databaseHooks: { session: accessSessionHooks(db) },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      // SDK-only organization operations must not acquire an accidental public API.
      if (
        context.path === "/request-password-reset" ||
        context.path === "/reset-password" ||
        context.path.startsWith("/reset-password/") ||
        context.path.startsWith("/organization/") ||
        context.path.startsWith("/admin/")
      )
        throw new APIError("FORBIDDEN", {
          message: "Use protected instance access settings.",
        });
      // Stale cookies must not trap a restored member out of normal sign-in/sign-out.
      const current = ["/sign-in/email", "/sign-out"].includes(context.path)
        ? null
        : await getAuthoritativeSessionFromCtx(context);
      if (
        current &&
        !(await readActivePrincipal(db, current.user.id, current.session.id))
      )
        throw new APIError("UNAUTHORIZED", {
          message: "Your instance access has changed. Sign in again.",
        });
      if (context.path === "/update-user") {
        const input = ProfileUpdateSchema.safeParse(context.body);
        if (!input.success)
          throw new APIError("BAD_REQUEST", {
            message: "Provide only a display name of 1–100 characters.",
          });
        return { context: { body: input.data } };
      }
    }),
  },
  // The secret used to sign session tokens.
  // Changing this invalidates all existing sessions.
  secret,

  // The base URL of this API app.
  // Better Auth uses this to construct callback URLs and set cookie domains.
  baseURL: appUrl,

  // Tell Better Auth which origins are allowed to make cross-origin requests.
  // Without this, Better Auth rejects preflight requests from apps/web.
  trustedOrigins: [process.env.WRENLY_WEB_URL ?? "http://localhost:3000"],

  // Use Drizzle as the database adapter.
  // Passes our shared db client and schema — Better Auth reads/writes
  // user, session, account, and verification tables through this.
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user,
      session,
      account,
      verification,
      organization,
      member,
      invitation,
    },
  }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Owner bootstrap and invitation acceptance must be separately authorized.
    disableSignUp: true,

    // Account creation is operator-proof/invitation gated. Self-hosted sign-in does
    // not require an external mail service; email delivery is a separate capability.
    requireEmailVerification: false,
  },

  // Session cookie configuration.
  session: {
    cookieName: "wrenly_session",
    additionalFields: ACCESS_SESSION_FIELDS,
    // 30 days — users stay logged in across browser restarts.
    expiresIn: 60 * 60 * 24 * 30,
  },
});
