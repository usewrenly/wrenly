/**
 * Instance member suspension/restoration.
 * Verified owner actions use native Better Auth under the same transaction as audit and preview revocation.
 * Queue/account locks fence delayed admissions; active or uncertain work blocks unsafe changes.
 * Preserve projects/history and never suspend the owner.
 */
import { lockAccountWorkQueues, accountWorkBlockers } from "../access/account-work";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  user,
  session,
  member,
  instanceSetup,
  memberAccessAudit,
  previewAccess,
  previews,
} from "../../../../../../packages/db/src/schema";
import { createInstanceAuth } from "../configuration/instance-auth";
import type { OwnerAuthConfiguration } from "../setup/owner-account";
import { readActivePrincipal } from "../access/access-policy";
import { logger } from "../../../lib/logger";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const INSTANCE_ID = 1;
const MAX_ERROR_CAUSE_DEPTH = 4;
const Input = z
  .object({
    requestId: z.string().uuid(),
    targetId: z.string().min(1).max(200),
    action: z.enum(["suspend", "restore"]),
    expectedRevision: z.string().uuid(),
  })
  .strict();
const RequestId = z.string().uuid();
export class MemberAccessError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "MemberAccessError";
  }
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MemberAccessError) throw error;
    let cause: unknown = error;
    for (
      let depth = 0;
      depth < MAX_ERROR_CAUSE_DEPTH && cause && typeof cause === "object";
      depth++
    ) {
      if ("code" in cause && (cause.code === "55P03" || cause.code === "40P01"))
        throw new MemberAccessError(
          409,
          "Member access is busy. Wait for active work, then review again.",
        );
      cause = "cause" in cause ? cause.cause : null;
    }
    logger.error("Member access operation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new MemberAccessError(
      503,
      "Member access could not be confirmed. Check its saved status before trying another change.",
    );
  }
}
async function lockOwner(tx: Transaction, actorId: string): Promise<string> {
  const [setup] = await tx
    .select()
    .from(instanceSetup)
    .where(eq(instanceSetup.id, INSTANCE_ID))
    .for("update", { noWait: true });
  if (!setup?.organizationId || setup.ownerId !== actorId)
    throw new MemberAccessError(
      403,
      "Only the instance owner can manage member access.",
    );
  return setup.organizationId;
}
/** Reconciles an exact action without issuing another native mutation. */
export function getMemberAccessAction(
  database: typeof db,
  actorId: string,
  id: string,
): Promise<unknown> {
  return operation(() =>
    database.transaction(async (tx) => {
      if (!RequestId.safeParse(id).success)
        throw new MemberAccessError(400, "Invalid access request.");
      await lockOwner(tx, actorId);
      const [action] = await tx
        .select()
        .from(memberAccessAudit)
        .where(
          and(
            eq(memberAccessAudit.id, id),
            eq(memberAccessAudit.actorId, actorId),
          ),
        );
      const [current] = action
        ? await tx
            .select({ revision: user.accessRevision, suspended: user.banned })
            .from(user)
            .where(eq(user.id, action.targetId))
        : [];
      return {
        current: current ?? null,
        action: action
          ? {
              requestId: action.id,
              targetId: action.targetId,
              action: action.action,
              revision: action.revision,
            }
          : null,
      };
    }),
  );
}
/** Suspends/restores only a current non-owner member, preserving their account and all project ownership. */
export function changeMemberAccess(
  database: typeof db,
  actorId: string,
  headers: Headers,
  raw: unknown,
  config: OwnerAuthConfiguration,
  beforeAudit: () => Promise<void> = async () => {},
): Promise<{
  requestId: string;
  targetId: string;
  action: string;
  revision: string;
  replayed: boolean;
}> {
  return operation(async () => {
    const parsed = Input.safeParse(raw);
    if (!parsed.success)
      throw new MemberAccessError(
        400,
        "Provide a valid member, action and access revision.",
      );
    const input = parsed.data;
    return database.transaction(async (tx) => {
      const organizationId = await lockOwner(tx, actorId);
      if (input.targetId === actorId)
        throw new MemberAccessError(
          403,
          "The instance owner cannot suspend their own access.",
        );
      await lockAccountWorkQueues(tx);
      const [target] = await tx
        .select()
        .from(user)
        .where(eq(user.id, input.targetId))
        .for("update", { noWait: true });
      const [membership] = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.userId, input.targetId),
            eq(member.organizationId, organizationId),
          ),
        );
      if (!target || !membership)
        throw new MemberAccessError(404, "Member not found.");
      const sdk = createInstanceAuth(tx, config, actorId);
      const current = await sdk.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });
      if (
        !current ||
        current.user.id !== actorId ||
        !(await readActivePrincipal(tx, actorId, current.session.id))
      )
        throw new MemberAccessError(
          401,
          "Sign in again before managing member access.",
        );
      const [prior] = await tx
        .select()
        .from(memberAccessAudit)
        .where(eq(memberAccessAudit.id, input.requestId));
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.targetId !== input.targetId ||
          prior.action !== input.action ||
          prior.previousRevision !== input.expectedRevision
        )
          throw new MemberAccessError(
            409,
            "That request identity belongs to another change.",
          );
        return {
          requestId: prior.id,
          targetId: prior.targetId,
          action: prior.action,
          revision: prior.revision,
          replayed: true,
        };
      }
      if (
        target.accessRevision !== input.expectedRevision ||
        target.banned === (input.action === "suspend")
      )
        throw new MemberAccessError(
          409,
          "Member access changed. Reload and review before continuing.",
        );
      if (input.action === "suspend") {
        const blocked = await accountWorkBlockers(tx, target.id);
        if (blocked.length)
          throw new MemberAccessError(
            409,
            blocked.join(" ") +
              " Finish or cancel the work, then review again.",
          );
        await sdk.api.banUser({
          headers,
          body: {
            userId: target.id,
            banReason: "Instance access suspended by the owner.",
          },
        });
      } else await sdk.api.unbanUser({ headers, body: { userId: target.id } });
      const revision = crypto.randomUUID();
      await tx
        .update(user)
        .set({ accessRevision: revision })
        .where(eq(user.id, target.id));
      await sdk.api.revokeUserSessions({
        headers,
        body: { userId: target.id },
      });
      await tx.delete(previewAccess).where(eq(previewAccess.userId, target.id));
      await tx
        .update(previews)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(
          and(eq(previews.userId, target.id), eq(previews.status, "ready")),
        );
      await beforeAudit();
      await tx.insert(memberAccessAudit).values({
        id: input.requestId,
        actorId,
        targetId: target.id,
        action: input.action,
        previousRevision: target.accessRevision,
        revision,
      });
      return {
        requestId: input.requestId,
        targetId: target.id,
        action: input.action,
        revision,
        replayed: false,
      };
    });
  });
}
/** Checks all required columns before the API starts accepting sessions. */
export async function verifyMemberAccessSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select().from(memberAccessAudit).limit(0);
    await database
      .select({
        revision: user.accessRevision,
        banned: user.banned,
        role: user.role,
        reason: user.banReason,
        expires: user.banExpires,
      })
      .from(user)
      .limit(0);
    await database
      .select({
        revision: session.accessRevision,
        impersonatedBy: session.impersonatedBy,
      })
      .from(session)
      .limit(0);
  } catch (error) {
    throw new Error(
      "Member access requires migration 0019. Run bun run db:migrate from packages/db.",
      { cause: error },
    );
  }
}
