/**
 * First-owner credential creation.
 * Called only inside the protected initialization transaction after proof validation.
 * Uses Better Auth password handling with automatic sign-in disabled; never mount its signup-enabled provisioning handler.
 */
import {
  accessSessionHooks,
  ACCESS_USER_FIELDS,
  ACCESS_SESSION_FIELDS,
} from "../access/access-policy";
import { admin } from "better-auth/plugins";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { db } from "@wrenly/db";
import {
  user,
  session,
  account,
  verification,
} from "../../../../../../packages/db/src/schema/identity/auth";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface OwnerCredentials {
  name: string;
  email: string;
  password: string;
}
export interface OwnerAuthConfiguration {
  secret: string;
  apiUrl: string;
  webUrl: string;
}

/** Uses Better Auth's credential pipeline in the caller's atomic initialization transaction. */
export async function createOwnerAccount(
  transaction: Transaction,
  config: OwnerAuthConfiguration,
  credentials: OwnerCredentials,
): Promise<string> {
  try {
    const provisioning = betterAuth({
      logger: { disabled: true },
      secret: config.secret,
      baseURL: config.apiUrl,
      trustedOrigins: [config.webUrl],
      user: { additionalFields: ACCESS_USER_FIELDS },
      session: { additionalFields: ACCESS_SESSION_FIELDS },
      databaseHooks: { session: accessSessionHooks(transaction) },
      database: drizzleAdapter(transaction, {
        provider: "pg",
        schema: { user, session, account, verification },
        transaction: false,
      }),
      plugins: [admin()],
      emailAndPassword: {
        enabled: true,
        disableSignUp: false,
        autoSignIn: false,
        minPasswordLength: 8,
        maxPasswordLength: 128,
      },
    });
    const result = await provisioning.api.signUpEmail({ body: credentials });
    return result.user.id;
  } catch (error) {
    throw new Error("Owner credentials could not be created.", {
      cause: error,
    });
  }
}
