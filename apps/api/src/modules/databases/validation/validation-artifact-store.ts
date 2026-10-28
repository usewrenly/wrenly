/** Saves the first prepared image and its effect acknowledgement in one transaction. */
import { RuntimeArtifactCompilationError } from "@wrenly/sandbox/runtime-artifact";
import { eq } from "drizzle-orm";
import {
  appDatabaseOperations,
  appDatabaseValidations,
  type db,
} from "@wrenly/db";
import { AppDatabaseError } from "../database-contract";
import {
  heldClaim,
  lockDatabaseQueues,
  type DatabaseClaim,
} from "../database-store";
import { requireProjectCapability } from "../../projects/access/project-access";
import { assertDatabaseValidation } from "./validation-store";

/** A lost acknowledgement must recover; it never replaces an image or repeats preparation. */
export async function acknowledgeValidationArtifact(
  database: typeof db,
  claim: DatabaseClaim,
  imageId: string,
): Promise<void> {
  try {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error("Invalid immutable image");
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [actor] = await tx
        .select({ id: appDatabaseOperations.actorId })
        .from(appDatabaseOperations)
        .where(heldClaim(claim));
      if (!actor) throw new Error("Claim expired");
      await requireProjectCapability(
        tx,
        claim.projectId,
        actor.id,
        "contribute",
      );
      await assertDatabaseValidation(tx, claim);
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
        !validation?.ownsArtifact ||
        validation.imageId !== null ||
        operation.cleanupEffect ||
        operation.effect?.kind !== "prepare-validation-artifact" ||
        operation.effect.id !== `wrenly-artifact-${claim.id}`
      )
        throw new Error("Preparation identity changed");
      await tx
        .update(appDatabaseValidations)
        .set({ imageId })
        .where(eq(appDatabaseValidations.operationId, claim.id));
      const changed = await tx
        .update(appDatabaseOperations)
        .set({
          effect: null,
          completedEffects: [...operation.completedEffects, operation.effect],
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (changed.length !== 1) throw new Error("Acknowledgement lost");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Prepared validation image could not be acknowledged. Preserve its operation for cleanup.",
    );
  }
}

/** Records failed preparation separately from image provenance, only after all independent cleanup. */
export async function acknowledgeFailedValidationArtifact(
  database: typeof db,
  claim: DatabaseClaim,
  failure: RuntimeArtifactCompilationError,
): Promise<void> {
  try {
    if (
      !(failure instanceof RuntimeArtifactCompilationError) ||
      failure.operationId !== claim.id ||
      !Number.isInteger(failure.exitCode) ||
      failure.exitCode < 1 ||
      failure.exitCode >= 124
    )
      throw new Error("Confirmed compiler exit required");
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [actor] = await tx
        .select({ id: appDatabaseOperations.actorId })
        .from(appDatabaseOperations)
        .where(heldClaim(claim));
      if (!actor) throw new Error("Claim expired");
      await requireProjectCapability(
        tx,
        claim.projectId,
        actor.id,
        "contribute",
      );
      await assertDatabaseValidation(tx, claim);
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
      const artifactId = `wrenly-artifact-${claim.id}`;
      const targets = [
        ["artifact", artifactId],
        ["application", `wrenly-database-application-${claim.id}`],
        ["socket", `wrenly-database-socket-${claim.id}`],
        ["database", `wrenly-database-${claim.id}`],
      ];
      if (
        !operation ||
        operation.kind !== "validate-application" ||
        !validation?.ownsArtifact ||
        validation.imageId !== null ||
        operation.cleanupEffect ||
        operation.completedEffects.length !== 0 ||
        operation.effect?.kind !== "prepare-validation-artifact" ||
        operation.effect.id !== artifactId ||
        !targets.every(([kind, id]) =>
          operation.completedCleanupEffects.some(
            (effect) =>
              effect.kind === `cleanup-validation-${kind}` && effect.id === id,
          ),
        )
      )
        throw new Error("Failed preparation evidence is incomplete");
      const changed = await tx
        .update(appDatabaseOperations)
        .set({
          effect: null,
          completedEffects: [
            { ...operation.effect, kind: "failed-prepare-validation-artifact" },
          ],
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (changed.length !== 1) throw new Error("Failure acknowledgement lost");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Failed preparation could not be confirmed. Preserve its operation for recovery.",
    );
  }
}
