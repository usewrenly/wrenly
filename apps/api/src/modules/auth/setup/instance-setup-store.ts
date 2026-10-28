/**
 * Protected first-owner persistence.
 * Local operator proof issuance and browser claim share bounded hashed proofs, singleton locking and atomic account/owner writes.
 * Existing installations require verified recovery instead of silent ownership adoption.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, count } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import { instanceSetup, user } from "../../../../../../packages/db/src/schema";
import {
  createOwnerAccount,
  type OwnerAuthConfiguration,
} from "./owner-account";
import { logger } from "../../../lib/logger";
const SETUP_ID = 1;
const PROOF_TTL_MS = 10 * 60_000;
const MAX_FAILED_ATTEMPTS = 10;
const InputSchema = z
  .object({
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    requestId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(8).max(128),
  })
  .strict();
export type OwnerSetupInput = z.infer<typeof InputSchema>;
export type InstanceSetupStatus =
  "setup-required" | "initialized" | "recovery-required";
export class InstanceSetupError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "InstanceSetupError";
  }
}
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
async function storeOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InstanceSetupError) throw error;
    logger.error("Instance setup persistence failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new InstanceSetupError(
      503,
      "Instance setup is unavailable. Check PostgreSQL and apply migrations through 0014.",
    );
  }
}

/** Public readiness state only; database failure never means the instance is empty. */
export function getInstanceSetupStatus(
  database: typeof db,
): Promise<InstanceSetupStatus> {
  return storeOperation(async () => {
    const [setup] = await database
      .select()
      .from(instanceSetup)
      .where(eq(instanceSetup.id, SETUP_ID));
    if (setup?.ownerId) return "initialized";
    const [users] = await database.select({ value: count() }).from(user);
    return users?.value ? "recovery-required" : "setup-required";
  });
}

/** Operator-local proof minting; return plaintext once to the CLI, never to public HTTP. */
export function issueOwnerSetupProof(database: typeof db): Promise<string> {
  return storeOperation(() =>
    database.transaction(async (transaction) => {
      await transaction
        .insert(instanceSetup)
        .values({ id: SETUP_ID })
        .onConflictDoNothing();
      const [setup] = await transaction
        .select()
        .from(instanceSetup)
        .where(eq(instanceSetup.id, SETUP_ID))
        .for("update");
      const [users] = await transaction.select({ value: count() }).from(user);
      if (setup?.ownerId || users?.value)
        throw new InstanceSetupError(
          409,
          "This instance already has users. Verified owner recovery is required; setup cannot adopt existing accounts.",
        );
      const proof = randomBytes(32).toString("base64url");
      await transaction
        .update(instanceSetup)
        .set({
          proofHash: hash(proof),
          proofExpiresAt: new Date(Date.now() + PROOF_TTL_MS),
          failedAttempts: 0,
          updatedAt: new Date(),
        })
        .where(eq(instanceSetup.id, SETUP_ID));
      return proof;
    }),
  );
}

/** Creates exactly one owner and consumes its proof atomically; retries never reopen registration. */
export function claimInstanceOwner(
  database: typeof db,
  raw: unknown,
  configuration: OwnerAuthConfiguration,
  provision: typeof createOwnerAccount = createOwnerAccount,
): Promise<{ replayed: boolean }> {
  return storeOperation(async () => {
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success)
      throw new InstanceSetupError(
        400,
        "Provide a valid setup code, name, email and password of 8–128 characters.",
      );
    const input = parsed.data;
    const result = await database.transaction(async (transaction) => {
      await transaction
        .insert(instanceSetup)
        .values({ id: SETUP_ID })
        .onConflictDoNothing();
      const [setup] = await transaction
        .select()
        .from(instanceSetup)
        .where(eq(instanceSetup.id, SETUP_ID))
        .for("update");
      const suppliedHash = hash(input.proof);
      const matches =
        setup?.proofHash &&
        timingSafeEqual(
          Buffer.from(setup.proofHash, "hex"),
          Buffer.from(suppliedHash, "hex"),
        );
      if (setup?.ownerId) {
        if (
          matches &&
          setup.completedRequestId === input.requestId &&
          setup.completedEmail === input.email
        )
          return { replayed: true };
        return { denied: true };
      }
      const [users] = await transaction.select({ value: count() }).from(user);
      if (users?.value) return { recovery: true };
      if (
        !setup ||
        !matches ||
        !setup.proofExpiresAt ||
        setup.proofExpiresAt.getTime() <= Date.now() ||
        setup.failedAttempts >= MAX_FAILED_ATTEMPTS
      ) {
        if (setup)
          await transaction
            .update(instanceSetup)
            .set({
              failedAttempts: Math.min(
                MAX_FAILED_ATTEMPTS,
                setup.failedAttempts + 1,
              ),
              updatedAt: new Date(),
            })
            .where(eq(instanceSetup.id, SETUP_ID));
        return { denied: true };
      }
      const ownerId = await provision(transaction, configuration, {
        name: input.name,
        email: input.email,
        password: input.password,
      });
      await transaction
        .update(instanceSetup)
        .set({
          ownerId,
          initializedAt: new Date(),
          proofExpiresAt: null,
          completedRequestId: input.requestId,
          completedEmail: input.email,
          updatedAt: new Date(),
        })
        .where(eq(instanceSetup.id, SETUP_ID));
      return { replayed: false };
    });
    if ("recovery" in result)
      throw new InstanceSetupError(
        409,
        "Existing users require verified owner recovery. No ownership was changed.",
      );
    if ("denied" in result)
      throw new InstanceSetupError(
        403,
        "The setup code is invalid, expired, exhausted or already consumed. Ask the instance operator for a new setup link.",
      );
    return result;
  });
}
