/**
 * Protected instance invitation lifecycle.
 * Singleton locks serialize owner issuance/revocation and proof-bound acceptance.
 * New-account credentials, membership and proof consumption commit together; existing accounts require their real authenticated identity.
 * Invitation membership does not grant project access.
 */
import { readActivePrincipal } from "../access/access-policy";
import { profilePictureUrl } from "../profile/pictures/profile-picture-store";
import { profilePictures } from "@wrenly/db";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, count, gt, desc, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  instanceSetup,
  invitation,
  invitationAuthorization,
  invitationAudit,
  member,
  user,
  organization,
  session,
} from "../../../../../../packages/db/src/schema";
import { createInvitationAuth } from "./invitation-auth";
import type { OwnerAuthConfiguration } from "../setup/owner-account";
import { logger } from "../../../lib/logger";
const MAX_PENDING = 20;
const MAX_ATTEMPTS = 10;
const HISTORY_LIMIT = 100;
const ID = z.string().uuid();
const ProofInput = z
  .object({ id: ID, proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const AcceptInput = ProofInput.extend({
  requestId: ID,
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(8).max(128).optional(),
}).strict();
const IssueInput = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    requestId: ID,
  })
  .strict();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class InvitationError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}
const hash = (proof: string): string =>
  createHash("sha256").update(proof).digest("hex");
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvitationError) throw error;
    logger.error("Instance invitation operation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new InvitationError(
      503,
      "Instance invitations are unavailable. Try again; check migrations through 0014 if it persists.",
    );
  }
}
async function lockInstance(
  tx: Transaction,
): Promise<typeof instanceSetup.$inferSelect> {
  const [setup] = await tx
    .select()
    .from(instanceSetup)
    .where(eq(instanceSetup.id, 1))
    .for("update");
  if (!setup?.ownerId)
    throw new InvitationError(
      403,
      "Complete verified instance-owner setup first.",
    );
  return setup;
}
async function owner(
  tx: Transaction,
  actorId: string,
): Promise<typeof instanceSetup.$inferSelect> {
  const setup = await lockInstance(tx);
  if (setup.ownerId !== actorId)
    throw new InvitationError(
      403,
      "Only the instance owner can manage invitations.",
    );
  return setup;
}
async function ensureOrganization(
  tx: Transaction,
  actorId: string,
  config: OwnerAuthConfiguration,
): Promise<string> {
  const setup = await owner(tx, actorId);
  if (setup.organizationId) return setup.organizationId;
  const sdk = createInvitationAuth(tx, config);
  const created = await sdk.api.createOrganization({
    body: {
      name: "Wrenly instance",
      slug: `instance-${crypto.randomUUID()}`,
      userId: actorId,
    },
  });
  if (!created)
    throw new InvitationError(
      503,
      "Instance membership could not be initialized.",
    );
  await tx
    .update(instanceSetup)
    .set({ organizationId: created.id, updatedAt: new Date() })
    .where(eq(instanceSetup.id, 1));
  return created.id;
}
/** Failed proof attempts commit their counter without consuming membership. */
async function authorize(
  tx: Transaction,
  input: z.infer<typeof ProofInput>,
): Promise<{
  authorization: typeof invitationAuthorization.$inferSelect;
  invite: typeof invitation.$inferSelect;
} | null> {
  const [row] = await tx
    .select({ authorization: invitationAuthorization, invite: invitation })
    .from(invitationAuthorization)
    .innerJoin(
      invitation,
      eq(invitationAuthorization.invitationId, invitation.id),
    )
    .where(eq(invitationAuthorization.id, input.id))
    .for("update");
  if (!row) return null;
  const matches = timingSafeEqual(
    Buffer.from(row.authorization.proofHash, "hex"),
    Buffer.from(hash(input.proof), "hex"),
  );
  if (
    !matches ||
    row.authorization.revokedAt ||
    row.authorization.failedAttempts >= MAX_ATTEMPTS ||
    row.invite.expiresAt.getTime() <= Date.now() ||
    !["pending", "accepted"].includes(row.invite.status)
  ) {
    await tx
      .update(invitationAuthorization)
      .set({
        failedAttempts: Math.min(
          MAX_ATTEMPTS,
          row.authorization.failedAttempts + 1,
        ),
      })
      .where(eq(invitationAuthorization.id, input.id));
    return null;
  }
  return row;
}
const invalid = (): InvitationError =>
  new InvitationError(
    403,
    "This invitation is invalid, expired, revoked or exhausted. Ask the instance owner for a new link.",
  );
/** Initializes Better Auth membership once, only on an owner-authorized request. */
export function initializeInstanceMembership(
  database: typeof db,
  actorId: string,
  config: OwnerAuthConfiguration,
): Promise<void> {
  return operation(() =>
    database.transaction(async (tx) => {
      await ensureOrganization(tx, actorId, config);
    }),
  );
}
/** Owner-only metadata; never return saved proofs or credential records. */
export function listInstanceAccess(
  database: typeof db,
  actorId: string,
): Promise<{
  members: Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    isOwner: boolean;
    suspended: boolean;
    accessRevision: string;
    userId: string;
    pictureUrl: string | null;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    status: string;
    expiresAt: Date;
  }>;
}> {
  return operation(() =>
    database.transaction(async (tx) => {
      const setup = await owner(tx, actorId);
      if (!setup.organizationId) return { members: [], invitations: [] };
      const memberRows = await tx
        .select({
          id: member.id,
          userId: user.id,
          email: user.email,
          name: user.name,
          role: member.role,
          suspended: user.banned,
          accessRevision: user.accessRevision,
          pictureRevision: profilePictures.revision,
          hasPicture: isNotNull(profilePictures.imageBase64),
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .leftJoin(profilePictures, eq(profilePictures.userId, user.id))
        .where(eq(member.organizationId, setup.organizationId))
        .limit(HISTORY_LIMIT);
      const members = memberRows.map(
        ({ pictureRevision, hasPicture, ...entry }) => ({
          ...entry,
          isOwner: entry.userId === setup.ownerId,
          pictureUrl:
            hasPicture && pictureRevision
              ? profilePictureUrl(entry.userId, pictureRevision)
              : null,
        }),
      );
      const columns = {
        id: invitationAuthorization.id,
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        revokedAt: invitationAuthorization.revokedAt,
      };
      // Always include live invitations even after a long history of revoke/reissue.
      const pending = await tx
        .select(columns)
        .from(invitationAuthorization)
        .innerJoin(
          invitation,
          eq(invitationAuthorization.invitationId, invitation.id),
        )
        .where(
          and(
            eq(invitation.organizationId, setup.organizationId),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(invitation.createdAt))
        .limit(MAX_PENDING);
      const history = await tx
        .select(columns)
        .from(invitationAuthorization)
        .innerJoin(
          invitation,
          eq(invitationAuthorization.invitationId, invitation.id),
        )
        .where(eq(invitation.organizationId, setup.organizationId))
        .orderBy(desc(invitation.createdAt))
        .limit(HISTORY_LIMIT);
      const rows = [
        ...pending,
        ...history.filter(
          (row) => !pending.some((active) => active.id === row.id),
        ),
      ];
      return {
        members,
        invitations: rows.map((row) => ({
          id: row.id,
          email: row.email,
          expiresAt: row.expiresAt,
          status: row.revokedAt
            ? "revoked"
            : row.status === "pending" && row.expiresAt.getTime() <= Date.now()
              ? "expired"
              : row.status,
        })),
      };
    }),
  );
}
/** Issues a private link once; exact issuance retry never reconstructs a plaintext proof. */
export function issueInstanceInvitation(
  database: typeof db,
  actorId: string,
  headers: Headers,
  raw: unknown,
  config: OwnerAuthConfiguration,
): Promise<{ id: string; link: string }> {
  return operation(async () => {
    const parsed = IssueInput.safeParse(raw);
    if (!parsed.success)
      throw new InvitationError(
        400,
        "Provide a valid email and request identity.",
      );
    return database.transaction(async (tx) => {
      const organizationId = await ensureOrganization(tx, actorId, config);
      const [prior] = await tx
        .select({ id: invitationAuthorization.id })
        .from(invitationAuthorization)
        .where(
          eq(invitationAuthorization.issueRequestId, parsed.data.requestId),
        );
      if (prior)
        throw new InvitationError(
          409,
          "This issuance was already recorded. Its private link cannot be displayed again; revoke it and issue a new invitation.",
        );
      const [membership] = await tx
        .select({ id: member.id })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(user.email, parsed.data.email),
          ),
        );
      if (membership)
        throw new InvitationError(
          409,
          "That account is already an instance member.",
        );
      const [pending] = await tx
        .select({ value: count() })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
          ),
        );
      if ((pending?.value ?? 0) >= MAX_PENDING)
        throw new InvitationError(
          409,
          "Pending invitation capacity is full. Revoke unused invitations first.",
        );
      const [duplicate] = await tx
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.email, parsed.data.email),
            eq(invitation.status, "pending"),
            gt(invitation.expiresAt, new Date()),
          ),
        );
      if (duplicate)
        throw new InvitationError(
          409,
          "That email already has a pending invitation. Revoke it before issuing a replacement.",
        );
      const sdk = createInvitationAuth(tx, config);
      const invite = await sdk.api.createInvitation({
        headers,
        body: { email: parsed.data.email, role: "member", organizationId },
      });
      const id = crypto.randomUUID(),
        proof = randomBytes(32).toString("base64url");
      await tx.insert(invitationAuthorization).values({
        id,
        invitationId: invite.id,
        issueRequestId: parsed.data.requestId,
        proofHash: hash(proof),
      });
      await tx.insert(invitationAudit).values({
        authorizationId: id,
        actorId,
        email: invite.email,
        organizationId,
        role: "member",
        action: "issued",
      });
      const link = new URL("/accept-invitation", config.webUrl);
      if (
        link.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(link.hostname)
      )
        throw new InvitationError(
          400,
          "Private invitation links require HTTPS except on loopback development.",
        );
      link.hash = new URLSearchParams({ invitation: id, proof }).toString();
      return { id, link: link.href };
    });
  });
}
/** Revokes the plugin invitation and proof together; accepted memberships cannot be revoked this way. */
export function revokeInstanceInvitation(
  database: typeof db,
  actorId: string,
  headers: Headers,
  raw: unknown,
  config: OwnerAuthConfiguration,
): Promise<void> {
  return operation(async () => {
    const parsed = z.object({ id: ID }).strict().safeParse(raw);
    if (!parsed.success)
      throw new InvitationError(400, "Provide a valid invitation ID.");
    await database.transaction(async (tx) => {
      const setup = await owner(tx, actorId);
      const [row] = await tx
        .select({ authorization: invitationAuthorization, invite: invitation })
        .from(invitationAuthorization)
        .innerJoin(
          invitation,
          eq(invitationAuthorization.invitationId, invitation.id),
        )
        .where(eq(invitationAuthorization.id, parsed.data.id))
        .for("update");
      if (!row || row.invite.organizationId !== setup.organizationId)
        throw new InvitationError(409, "Invitation not found.");
      if (row.authorization.revokedAt) return;
      if (row.invite.status !== "pending")
        throw new InvitationError(
          409,
          "Only pending invitations can be revoked. Membership removal is a separate operation.",
        );
      await createInvitationAuth(tx, config).api.cancelInvitation({
        headers,
        body: { invitationId: row.invite.id },
      });
      await tx
        .update(invitationAuthorization)
        .set({ revokedAt: new Date() })
        .where(eq(invitationAuthorization.id, parsed.data.id));
      await tx.insert(invitationAudit).values({
        authorizationId: parsed.data.id,
        actorId,
        email: row.invite.email,
        organizationId: row.invite.organizationId,
        role: "member",
        action: "revoked",
      });
    });
  });
}
/** Possession-gated inspection; failed guesses commit their bounded attempt count. */
export function inspectInstanceInvitation(
  database: typeof db,
  raw: unknown,
): Promise<{ email: string; existingAccount: boolean; accepted: boolean }> {
  return operation(async () => {
    const input = ProofInput.safeParse(raw);
    if (!input.success) throw invalid();
    const result = await database.transaction(async (tx) => {
      const setup = await lockInstance(tx);
      const row = await authorize(tx, input.data);
      if (
        !row ||
        row.invite.organizationId !== setup.organizationId ||
        row.invite.role !== "member"
      )
        return null;
      const [existing] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, row.invite.email));
      return {
        email: row.invite.email,
        existingAccount: Boolean(existing),
        accepted: Boolean(row.authorization.acceptedAt),
      };
    });
    if (!result) throw invalid();
    return result;
  });
}
/** Creates credentials/membership/consumption/audit atomically using only Better Auth SDK operations. */
export function acceptInstanceInvitation(
  database: typeof db,
  headers: Headers,
  raw: unknown,
  config: OwnerAuthConfiguration,
  afterMembership: () => Promise<void> = async () => {},
): Promise<{ email: string; accountCreated: boolean; replayed: boolean }> {
  return operation(async () => {
    const input = AcceptInput.safeParse(raw);
    if (!input.success)
      throw new InvitationError(
        400,
        "Provide valid invitation details; new passwords must be 8–128 characters.",
      );
    const result = await database.transaction(async (tx) => {
      const setup = await lockInstance(tx);
      const row = await authorize(tx, input.data);
      if (
        !row ||
        row.invite.organizationId !== setup.organizationId ||
        row.invite.role !== "member"
      )
        return null;
      const sdk = createInvitationAuth(tx, config);
      const candidate = await sdk.api.getSession({ headers });
      const signedIn =
        candidate &&
        (await readActivePrincipal(tx, candidate.user.id, candidate.session.id))
          ? candidate
          : null;
      if (row.authorization.acceptedAt) {
        if (
          row.authorization.acceptRequestId !== input.data.requestId ||
          (!row.authorization.accountCreated &&
            signedIn?.user.id !== row.authorization.acceptedUserId)
        )
          throw new InvitationError(
            409,
            "This invitation was already accepted. Sign in normally.",
          );
        return {
          email: row.invite.email,
          accountCreated: Boolean(row.authorization.accountCreated),
          replayed: true,
        };
      }
      const [existing] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, row.invite.email));
      if (
        signedIn &&
        signedIn.user.email.toLowerCase() !== row.invite.email.toLowerCase()
      )
        throw new InvitationError(
          403,
          "Sign in to the account named in this invitation before accepting.",
        );
      let userId: string,
        acceptanceHeaders = headers,
        temporaryCookie: string | undefined;
      if (existing) {
        if (!signedIn || signedIn.user.id !== existing.id)
          throw new InvitationError(
            401,
            "This email already has an account. Sign in to that account before accepting.",
          );
        userId = existing.id;
      } else {
        if (!input.data.name || !input.data.password)
          throw new InvitationError(
            400,
            "Enter your name and a password of 8–128 characters.",
          );
        const created = await sdk.api.signUpEmail({
          body: {
            name: input.data.name,
            email: row.invite.email,
            password: input.data.password,
          },
        });
        userId = created.user.id;
        // The plugin's accept API requires an actual session. A private temporary
        // Better Auth login satisfies it, then is revoked before commit; no cookie is exposed.
        const login = await sdk.api.signInEmail({
          body: { email: row.invite.email, password: input.data.password },
          returnHeaders: true,
        });
        temporaryCookie = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        acceptanceHeaders = new Headers({ Cookie: temporaryCookie });
      }
      await sdk.api.acceptInvitation({
        headers: acceptanceHeaders,
        body: { invitationId: row.invite.id },
      });
      await afterMembership();
      if (temporaryCookie)
        await sdk.api.signOut({ headers: acceptanceHeaders });
      await tx
        .update(invitationAuthorization)
        .set({
          acceptRequestId: input.data.requestId,
          acceptedUserId: userId,
          accountCreated: existing ? 0 : 1,
          acceptedAt: new Date(),
        })
        .where(eq(invitationAuthorization.id, input.data.id));
      await tx.insert(invitationAudit).values({
        authorizationId: input.data.id,
        actorId: userId,
        email: row.invite.email,
        organizationId: row.invite.organizationId,
        role: "member",
        action: "accepted",
      });
      return {
        email: row.invite.email,
        accountCreated: !existing,
        replayed: false,
      };
    });
    if (!result) throw invalid();
    return result;
  });
}
/** Preflight all invitation and plugin schema fields before serving authentication. */
export function verifyInvitationSchema(database: typeof db): Promise<void> {
  return operation(async () => {
    await database.select().from(organization).limit(0);
    await database.select().from(member).limit(0);
    await database.select().from(invitation).limit(0);
    await database.select().from(invitationAuthorization).limit(0);
    await database.select().from(invitationAudit).limit(0);
    await database.select().from(session).limit(0);
    await database
      .select({ organizationId: instanceSetup.organizationId })
      .from(instanceSetup)
      .limit(0);
  });
}
