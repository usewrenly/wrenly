/**
 * Protected transaction-bound Better Auth SDK.
 * Setup, invitations and member administration use native credential/membership operations inside their already-authorized transaction.
 * Never mount this SDK handler on HTTP.
 * An administrator override must be verified by the caller before constructing it.
 */
import {
  accessSessionHooks,
  ACCESS_USER_FIELDS,
  ACCESS_SESSION_FIELDS,
} from "../access/access-policy";
import { admin } from "better-auth/plugins";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { db } from "@wrenly/db";
import {
  user,
  session,
  account,
  verification,
  organization as organizationTable,
  member,
  invitation,
} from "../../../../../../packages/db/src/schema";
import type { OwnerAuthConfiguration } from "../setup/owner-account";
import { INSTANCE_ORGANIZATION_OPTIONS } from "./organization-options";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
function buildInstanceAuth(
  transaction: Transaction,
  config: OwnerAuthConfiguration,
  administratorId?: string,
) {
  return betterAuth({
    logger: { disabled: true },
    secret: config.secret,
    baseURL: config.apiUrl,
    trustedOrigins: [config.webUrl],
    user: { additionalFields: ACCESS_USER_FIELDS },
    session: { additionalFields: ACCESS_SESSION_FIELDS },
    databaseHooks: { session: accessSessionHooks(transaction) },
    database: drizzleAdapter(transaction, {
      provider: "pg",
      schema: {
        user,
        session,
        account,
        verification,
        organization: organizationTable,
        member,
        invitation,
      },
      transaction: false,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    plugins: [
      organization(INSTANCE_ORGANIZATION_OPTIONS),
      admin({ adminUserIds: administratorId ? [administratorId] : [] }),
    ],
  });
}
/** Creates an HTTP-unmounted Better Auth SDK for protected instance operations. An administrator ID must already have been authorized by the caller. */
export function createInstanceAuth(
  transaction: Transaction,
  config: OwnerAuthConfiguration,
  administratorId?: string,
): ReturnType<typeof buildInstanceAuth> {
  return buildInstanceAuth(transaction, config, administratorId);
}
