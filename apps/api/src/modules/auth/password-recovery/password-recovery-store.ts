/**
 * Recover an existing account using a short-lived proof issued on its own server.
 * Better Auth changes the credential; this transaction also fences stale access and
 * remembers exact completion so an uncertain response never repeats the reset.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  user,
  verification,
  previewAccess,
} from "../../../../../../packages/db/src/schema";
import { createInstanceAuth } from "../configuration/instance-auth";
import {
  accountWorkBlockers,
  lockAccountWorkQueues,
} from "../access/account-work";
import type { OwnerAuthConfiguration } from "../setup/owner-account";
import { logger } from "../../../lib/logger";
const PROOF_TTL_MS = 10 * 60_000;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const PREFIX = "wrenly-password-recovery:";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const PasswordRecoveryInput = z
  .object({
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    requestId: z.string().uuid(),
    password: z.string().min(8).max(128),
  })
  .strict();
const Record = z.object({
  userId: z.string().min(1).max(200),
  revision: z.string().uuid(),
  completed: z
    .object({
      requestId: z.string().uuid(),
      identity: z.string(),
      revision: z.string().uuid(),
    })
    .nullable(),
});
export class PasswordRecoveryError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "PasswordRecoveryError";
  }
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PasswordRecoveryError) throw error;
    logger.error("Password recovery could not be confirmed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new PasswordRecoveryError(
      503,
      "Password recovery could not be confirmed. Retry the same submission before requesting a new link.",
    );
  }
}
/** Only a local server command calls this function; there is no public proof-issuing route. */
export function issuePasswordRecovery(
  database: typeof db,
  email: string,
): Promise<string> {
  return operation(async () => {
    const parsed = z.email().max(254).safeParse(email.trim().toLowerCase());
    if (!parsed.success)
      throw new PasswordRecoveryError(
        400,
        "Provide the existing account email.",
      );
    return database.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(user)
        .where(eq(user.email, parsed.data))
        .for("share");
      if (!target || target.banned)
        throw new PasswordRecoveryError(
          409,
          "An active existing account is required. No credential was changed.",
        );
      const proof = randomBytes(32).toString("base64url"),
        id = PREFIX + hash(proof);
      await tx
        .insert(verification)
        .values({
          id,
          identifier: id,
          value: JSON.stringify({
            userId: target.id,
            revision: target.accessRevision,
            completed: null,
          }),
          expiresAt: new Date(Date.now() + PROOF_TTL_MS),
        });
      return proof;
    });
  });
}
/** Consumes a proof once, then acknowledges only the exact same completion request. */
export function completePasswordRecovery(
  database: typeof db,
  config: OwnerAuthConfiguration,
  raw: unknown,
): Promise<{ replayed: boolean }> {
  return operation(async () => {
    const parsed = PasswordRecoveryInput.safeParse(raw);
    if (!parsed.success)
      throw new PasswordRecoveryError(
        400,
        "Provide the private recovery link and a password of 8–128 characters.",
      );
    const input = parsed.data,
      id = PREFIX + hash(input.proof);
    const identity = createHmac("sha256", config.secret)
      .update(
        JSON.stringify([
          "password-recovery-v1",
          id,
          input.requestId,
          input.password,
        ]),
      )
      .digest("hex");
    return database.transaction(async (tx) => {
      // Read only to locate the account; authority is checked again under both locks.
      const [candidate] = await tx
        .select()
        .from(verification)
        .where(eq(verification.id, id));
      const candidateData =
        candidate && Record.safeParse(JSON.parse(candidate.value));
      if (!candidateData || !candidateData.success)
        throw new PasswordRecoveryError(
          400,
          "Recovery link is invalid or expired. Request a new private link.",
        );
      await lockAccountWorkQueues(tx);
      const [target] = await tx
        .select()
        .from(user)
        .where(eq(user.id, candidateData.data.userId))
        .for("update", { noWait: true });
      const [saved] = await tx
        .select()
        .from(verification)
        .where(eq(verification.id, id))
        .for("update", { noWait: true });
      if (!saved || saved.expiresAt.getTime() <= Date.now())
        throw new PasswordRecoveryError(
          400,
          "Recovery link is invalid or expired. Request a new private link.",
        );
      const record = Record.parse(JSON.parse(saved.value));
      if (!target || target.banned || target.id !== record.userId)
        throw new PasswordRecoveryError(
          403,
          "Recovery is unavailable for this account. Contact the instance owner.",
        );
      if (record.completed) {
        if (
          record.completed.requestId !== input.requestId ||
          record.completed.identity !== identity ||
          target.accessRevision !== record.completed.revision
        )
          throw new PasswordRecoveryError(
            409,
            "This link was already used or account access changed. Sign in or request a new private link.",
          );
        return { replayed: true };
      }
      if (target.accessRevision !== record.revision)
        throw new PasswordRecoveryError(
          409,
          "Account access changed. Request a new private recovery link.",
        );
      const blockers = await accountWorkBlockers(tx, target.id);
      if (blockers.length)
        throw new PasswordRecoveryError(
          409,
          blockers.join(" ") +
            " Finish or reconcile this work before resetting the password.",
        );
      // The native token exists only inside this transaction and is never sent to a browser.
      const nativeToken = randomBytes(32).toString("base64url");
      await tx
        .insert(verification)
        .values({
          id: crypto.randomUUID(),
          identifier: `reset-password:${nativeToken}`,
          value: target.id,
          expiresAt: saved.expiresAt,
        });
      await createInstanceAuth(tx, config).api.resetPassword({
        body: { token: nativeToken, newPassword: input.password },
      });
      const revision = crypto.randomUUID();
      await tx
        .update(user)
        .set({ accessRevision: revision, updatedAt: new Date() })
        .where(eq(user.id, target.id));
      await tx.delete(previewAccess).where(eq(previewAccess.userId, target.id));
      await tx
        .update(verification)
        .set({
          value: JSON.stringify({
            ...record,
            completed: { requestId: input.requestId, identity, revision },
          }),
          expiresAt: new Date(Date.now() + RECEIPT_TTL_MS),
          updatedAt: new Date(),
        })
        .where(
          and(eq(verification.id, id), eq(verification.value, saved.value)),
        );
      return { replayed: false };
    });
  });
}
