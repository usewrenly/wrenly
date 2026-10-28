/** Independent validation cleanup and completion; generated execution has a stricter parent fence. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  appDatabaseOperations,
  appDatabaseValidations,
  type db,
} from "@wrenly/db";
import { requireProjectCapability } from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";
import {
  DATABASE_LEASE_MS,
  heldClaim,
  lockDatabaseQueues,
  type DatabaseClaim,
} from "../database-store";
import { assertDatabaseValidation } from "./validation-store";
export const VALIDATION_CLEANUP_GRACE_MS = 60_000;
const MAX_CLEANUP_RECEIPTS = 32;
const Result = z
  .object({
    migrationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    schemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
    httpReady: z.literal(true),
  })
  .strict();
export type ValidationResult = z.infer<typeof Result>;
export type ValidationCleanupKind =
  "application" | "socket" | "database" | "artifact";
const cleanupName = (kind: ValidationCleanupKind, id: string): string =>
  kind === "artifact"
    ? `wrenly-artifact-${id}`
    : kind === "database"
      ? `wrenly-database-${id}`
      : `wrenly-database-${kind}-${id}`;

/** Cleanup can outlive parent cancellation, never its own lease or bounded cleanup deadline. */
export async function assertValidationCleanupLease(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    const [row] = await database
      .select({ deadline: appDatabaseValidations.deadlineAt })
      .from(appDatabaseOperations)
      .innerJoin(
        appDatabaseValidations,
        eq(appDatabaseValidations.operationId, appDatabaseOperations.id),
      )
      .where(
        and(
          heldClaim(claim),
          eq(appDatabaseOperations.kind, "validate-application"),
        ),
      )
      .limit(1);
    if (
      !row ||
      Date.now() >= row.deadline.getTime() + VALIDATION_CLEANUP_GRACE_MS
    )
      throw new Error("Cleanup lease lost");
  } catch {
    throw new AppDatabaseError(
      409,
      "Validation cleanup ownership expired. Preserve the operation for recovery.",
    );
  }
}

/** Extending cleanup never authorizes new app work; execution still checks the parent and app deadline. */
export async function maintainValidationCleanupLease(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    await assertValidationCleanupLease(database, claim);
    const [row] = await database
      .select({ deadline: appDatabaseValidations.deadlineAt })
      .from(appDatabaseValidations)
      .where(eq(appDatabaseValidations.operationId, claim.id));
    if (!row) throw new Error("Validation missing");
    const changed = await database
      .update(appDatabaseOperations)
      .set({
        leaseExpiresAt: new Date(
          Math.min(
            Date.now() + DATABASE_LEASE_MS,
            row.deadline.getTime() + VALIDATION_CLEANUP_GRACE_MS,
          ),
        ),
      })
      .where(heldClaim(claim))
      .returning({ id: appDatabaseOperations.id });
    if (changed.length !== 1) throw new Error("Cleanup claim changed");
  } catch {
    throw new AppDatabaseError(
      409,
      "Validation cleanup lease could not be renewed.",
    );
  }
}

/** Only the operation-owned disposable targets may receive a cleanup intent. */
export async function recordValidationCleanup(
  database: typeof db,
  claim: DatabaseClaim,
  kind: ValidationCleanupKind,
  id: string,
): Promise<void> {
  try {
    if (id !== cleanupName(kind, claim.id))
      throw new Error("Wrong cleanup target");
    await assertValidationCleanupLease(database, claim);
    await database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .for("update");
      if (
        !row ||
        row.kind !== "validate-application" ||
        row.cleanupEffect ||
        row.completedCleanupEffects.length >= MAX_CLEANUP_RECEIPTS
      )
        throw new Error("Cleanup is unresolved");
      const changed = await tx
        .update(appDatabaseOperations)
        .set({
          cleanupEffect: {
            kind: `cleanup-validation-${kind}`,
            id,
            startedAt: new Date().toISOString(),
          },
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (changed.length !== 1) throw new Error("Cleanup lease lost");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Validation cleanup intent could not be confirmed.",
    );
  }
}

/** Returns success only after verified execution and cleanup; never mutates the real database row. */
export async function finishDatabaseValidation(
  database: typeof db,
  claim: DatabaseClaim,
  outcome:
    | { success: true; result: ValidationResult }
    | {
        success: false;
        errorCode: "VALIDATION_FAILED" | "VALIDATION_CANCELLED";
      },
): Promise<void> {
  try {
    const result = outcome.success ? Result.parse(outcome.result) : undefined;
    await assertValidationCleanupLease(database, claim);
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [actor] = await tx
        .select({ actorId: appDatabaseOperations.actorId })
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .limit(1);
      if (!actor) throw new Error("Validation lease lost");
      if (outcome.success) {
        await requireProjectCapability(
          tx,
          claim.projectId,
          actor.actorId,
          "contribute",
        );
        await assertDatabaseValidation(tx, claim);
      }
      const [operation] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .for("update");
      const [validation] = await tx
        .select()
        .from(appDatabaseValidations)
        .where(eq(appDatabaseValidations.operationId, claim.id))
        .for("update");
      if (
        !operation ||
        operation.kind !== "validate-application" ||
        !validation ||
        operation.effect ||
        operation.cleanupEffect
      )
        throw new Error("Uncertain effects remain");
      const cleaned = (["application", "socket", "database"] as const).every(
        (kind) =>
          operation.completedCleanupEffects.some(
            (effect) =>
              effect.kind === `cleanup-validation-${kind}` &&
              effect.id === cleanupName(kind, claim.id),
          ),
      );
      if (
        (outcome.success || operation.completedEffects.length > 0) &&
        !cleaned
      )
        throw new Error("Cleanup is not confirmed");
      if (
        validation.ownsArtifact &&
        !operation.completedCleanupEffects.some(
          (effect) =>
            effect.kind === "cleanup-validation-artifact" &&
            effect.id === cleanupName("artifact", claim.id),
        )
      )
        throw new Error("Artifact cleanup is not confirmed");
      if (
        outcome.success &&
        (!result ||
          result.migrationDigest !== validation.migrationDigest ||
          result.migrationDigest !== operation.migrationDigest ||
          ![
            "provision-roles",
            "apply-migrations",
            "enforce-policy",
            "inspect-schema",
          ].every((kind) =>
            operation.completedEffects.some((effect) => effect.kind === kind),
          ) ||
          !operation.completedEffects.some(
            (effect) =>
              effect.kind === "create-container" &&
              effect.id === `wrenly-database-application-${claim.id}`,
          ))
      )
        throw new Error("Execution result is not verified");
      if (
        outcome.success &&
        validation.ownsArtifact &&
        (!validation.imageId ||
          !operation.completedEffects.some(
            (effect) =>
              effect.kind === "prepare-validation-artifact" &&
              effect.id === `wrenly-artifact-${claim.id}`,
          ))
      )
        throw new Error("Prepared artifact is not acknowledged");
      if (result)
        await tx
          .update(appDatabaseValidations)
          .set({ schemaDigest: result.schemaDigest })
          .where(eq(appDatabaseValidations.operationId, claim.id));
      const finished = await tx
        .update(appDatabaseOperations)
        .set({
          status: outcome.success ? "success" : "failed",
          errorCode: outcome.success ? null : outcome.errorCode,
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (finished.length !== 1)
        throw new Error("Validation completion lease lost");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Validation completion is not confirmed. Preserve its saved operation for inspection.",
    );
  }
}
