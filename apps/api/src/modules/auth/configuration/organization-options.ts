/**
 * Instance organization limits shared by public and protected Better Auth configurations.
 * Organization creation is not a public capability.
 * Invitation proof checks and owner authorization live in Wrenly stores, not these plugin defaults.
 */
// protected server operations additionally require a hashed, email-bound invitation proof.
export const INSTANCE_ORGANIZATION_OPTIONS = {
  allowUserToCreateOrganization: false,
  organizationLimit: 1,
  membershipLimit: 100,
  invitationLimit: 20,
  invitationExpiresIn: 48 * 60 * 60,
  requireEmailVerificationOnInvitation: false,
} as const;
