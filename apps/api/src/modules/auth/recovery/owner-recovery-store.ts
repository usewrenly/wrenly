/**
 * Existing-instance owner recovery.
 * Local operator proof is bound to one existing account; browser confirmation also requires that account’s real sign-in.
 * Hashed expiring proofs, bounded attempts and atomic audit prevent credential replacement or silent project reassignment.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  instanceSetup,
  instanceOwnerRecovery,
  instanceOwnerRecoveryAudit,
  user,
} from "../../../../../../packages/db/src/schema";
import { InstanceSetupError } from "../setup/instance-setup-store";
import { logger } from "../../../lib/logger";
const SINGLETON_ID = 1;
const PROOF_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 10;
const Input = z
  .object({
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    requestId: z.string().uuid(),
  })
  .strict();
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InstanceSetupError) throw error;
    logger.error("Owner recovery persistence failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new InstanceSetupError(
      503,
      "Owner recovery is unavailable. Check PostgreSQL and apply migrations through 0014.",
    );
  }
}
/** Operator-local authorization bound to one existing account; never an HTTP minting endpoint. */
export function issueOwnerRecoveryProof(
  database: typeof db,
  email: string,
): Promise<string> {
  return operation(() =>
    database.transaction(async (tx) => {
      const parsed = z.email().max(254).safeParse(email.trim().toLowerCase());
      if (!parsed.success)
        throw new InstanceSetupError(
          400,
          "Provide the existing account email.",
        );
      await tx
        .insert(instanceSetup)
        .values({ id: SINGLETON_ID })
        .onConflictDoNothing();
      const [setup] = await tx
        .select()
        .from(instanceSetup)
        .where(eq(instanceSetup.id, SINGLETON_ID))
        .for("update");
      if (setup?.ownerId)
        throw new InstanceSetupError(
          409,
          "This instance already has an owner. Recovery cannot replace it.",
        );
      const [target] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, parsed.data));
      if (!target)
        throw new InstanceSetupError(
          409,
          "No existing account matches that email. No account or credential was changed.",
        );
      const proof = randomBytes(32).toString("base64url");
      const values = {
        targetUserId: target.id,
        proofHash: hash(proof),
        expiresAt: new Date(Date.now() + PROOF_TTL_MS),
        failedAttempts: 0,
        completedAt: null,
        completedRequestId: null,
      };
      await tx
        .insert(instanceOwnerRecovery)
        .values({ id: SINGLETON_ID, ...values })
        .onConflictDoUpdate({ target: instanceOwnerRecovery.id, set: values });
      return proof;
    }),
  );
}
/** Requires both operator possession and the matching authenticated identity; never transfers projects. */
export function recoverInstanceOwner(
  database: typeof db,
  raw: unknown,
  sessionUserId: string,
): Promise<{ replayed: boolean }> {
  return operation(async () => {
    const parsed = Input.safeParse(raw);
    if (!parsed.success)
      throw new InstanceSetupError(
        400,
        "Provide a valid recovery code and request identity.",
      );
    const input = parsed.data;
    const result = await database.transaction(async (tx) => {
      await tx
        .insert(instanceSetup)
        .values({ id: SINGLETON_ID })
        .onConflictDoNothing();
      const [setup] = await tx
        .select()
        .from(instanceSetup)
        .where(eq(instanceSetup.id, SINGLETON_ID))
        .for("update");
      const [proof] = await tx
        .select()
        .from(instanceOwnerRecovery)
        .where(eq(instanceOwnerRecovery.id, SINGLETON_ID))
        .for("update");
      const matches =
        proof &&
        proof.targetUserId === sessionUserId &&
        timingSafeEqual(
          Buffer.from(proof.proofHash, "hex"),
          Buffer.from(hash(input.proof), "hex"),
        );
      if (setup?.ownerId) {
        return matches &&
          setup.ownerId === sessionUserId &&
          proof.completedRequestId === input.requestId &&
          proof.completedAt
          ? { replayed: true }
          : null;
      }
      if (
        !matches ||
        proof.completedAt ||
        proof.expiresAt.getTime() <= Date.now() ||
        proof.failedAttempts >= MAX_FAILURES
      ) {
        if (proof)
          await tx
            .update(instanceOwnerRecovery)
            .set({
              failedAttempts: Math.min(MAX_FAILURES, proof.failedAttempts + 1),
            })
            .where(eq(instanceOwnerRecovery.id, SINGLETON_ID));
        return null;
      }
      const now = new Date();
      await tx
        .update(instanceSetup)
        .set({
          ownerId: sessionUserId,
          initializedAt: now,
          updatedAt: now,
          proofHash: null,
          proofExpiresAt: null,
        })
        .where(eq(instanceSetup.id, SINGLETON_ID));
      await tx
        .update(instanceOwnerRecovery)
        .set({ completedAt: now, completedRequestId: input.requestId })
        .where(eq(instanceOwnerRecovery.id, SINGLETON_ID));
      await tx
        .insert(instanceOwnerRecoveryAudit)
        .values({ requestId: input.requestId, ownerId: sessionUserId });
      return { replayed: false };
    });
    if (!result)
      throw new InstanceSetupError(
        403,
        "Recovery authorization is invalid, expired, consumed or does not match your signed-in account.",
      );
    return result;
  });
}

/** Preflight recovery storage before listeners or workers can start. */
export function verifyOwnerRecoverySchema(database: typeof db): Promise<void> {
  return operation(async () => {
    await database.select().from(instanceOwnerRecovery).limit(0);
    await database.select().from(instanceOwnerRecoveryAudit).limit(0);
  });
}
