/**
 * Invitation-only Better Auth SDK factory.
 * Shares the authorized transaction without granting an instance-administrator override.
 * The caller verifies proof/account ownership; this factory must never supply a public HTTP handler.
 */
import type { db } from "@wrenly/db";
import type { OwnerAuthConfiguration } from "../setup/owner-account";
import { createInstanceAuth } from "../configuration/instance-auth";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Invitation SDK has no instance-administrator override and must never be HTTP mounted. */
export function createInvitationAuth(
  transaction: Transaction,
  config: OwnerAuthConfiguration,
): ReturnType<typeof createInstanceAuth> {
  return createInstanceAuth(transaction, config);
}
