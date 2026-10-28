import { logger } from "../../../lib/logger";
import {
  RuntimeArtifactError,
  RuntimeArtifactCompilationError,
} from "@wrenly/sandbox/runtime-artifact";
/**
 * Runs one saved disposable validation while its resource kernel lock and both claims are held.
 * No import/startup executes this, and failures never retry generated work automatically.
 */
import { cleanupDatabaseValidationResources } from "@wrenly/sandbox/database-validation-cleanup";
import { cleanupOwnedRuntimeArtifact } from "@wrenly/sandbox/runtime-artifact-cleanup";
import { prepareDatabaseValidationArtifact } from "@wrenly/sandbox/runtime-artifact";
import { eq } from "drizzle-orm";
import { appDatabaseValidations, type db } from "@wrenly/db";
import {
  acknowledgeValidationArtifact,
  acknowledgeFailedValidationArtifact,
} from "./validation-artifact-store";
import { acquireDatabaseExecutorLock } from "../database-executor-lock";
import {
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  acknowledgeDatabaseCleanupEffect,
  interruptDatabaseAction,
  type DatabaseClaim,
} from "../database-store";
import { validateFreshDatabaseApplication } from "../database-application-validation";
import {
  assertDatabaseValidation,
  loadDatabaseValidation,
} from "./validation-store";
import {
  assertValidationCleanupLease,
  maintainValidationCleanupLease,
  recordValidationCleanup,
  finishDatabaseValidation,
  type ValidationResult,
  type ValidationCleanupKind,
} from "./validation-effects";
const HEARTBEAT_MS = 5000;
export interface ValidationExecutionAdapters {
  validate?: typeof validateFreshDatabaseApplication;
  cleanup?: typeof cleanupDatabaseValidationResources;
  prepare?: typeof prepareDatabaseValidationArtifact;
  cleanupArtifact?: typeof cleanupOwnedRuntimeArtifact;
}
export type ValidationOutcome =
  | { status: "success"; result: ValidationResult }
  | { status: "failed"; diagnostics?: string }
  | { status: "interrupted" };

/** Owned preparation starts only once; older caller-owned image inputs retain their separate cleanup owner. */
export async function executeDatabaseValidation(
  database: typeof db,
  claim: DatabaseClaim,
  signal: AbortSignal,
  adapters: ValidationExecutionAdapters = {},
): Promise<ValidationOutcome> {
  const lock = await acquireDatabaseExecutorLock(claim);
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(new Error("Database validation cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let heartbeat: ReturnType<typeof setInterval> | undefined,
    renewal: Promise<void> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let ownsArtifact = false;
  const cleanupHeld = async (): Promise<void> => {
    lock.assertHeld();
    await assertValidationCleanupLease(database, claim);
    lock.assertHeld();
  };
  const held = async (): Promise<void> => {
    controller.signal.throwIfAborted();
    lock.assertHeld();
    await assertDatabaseValidation(database, claim);
    controller.signal.throwIfAborted();
    lock.assertHeld();
  };
  const cleanup = {
    assertHeld: cleanupHeld,
    beforeCleanup: async (
      kind: ValidationCleanupKind,
      id: string,
    ): Promise<void> => {
      await cleanupHeld();
      await recordValidationCleanup(database, claim, kind, id);
    },
    acknowledgeCleanup: async (
      _kind: ValidationCleanupKind,
      id: string,
    ): Promise<void> => {
      await cleanupHeld();
      await acknowledgeDatabaseCleanupEffect(database, claim, id);
    },
  };
  const cleanupArtifact = async (): Promise<void> => {
    if (!ownsArtifact) return;
    const id = `wrenly-artifact-${claim.id}`;
    await cleanup.beforeCleanup("artifact", id);
    await (adapters.cleanupArtifact ?? cleanupOwnedRuntimeArtifact)(
      claim.id,
      cleanupHeld,
    );
    await cleanup.acknowledgeCleanup("artifact", id);
  };
  let stage = "initialization";
  try {
    await cleanupHeld();
    const [ownership] = await database
      .select({ ownsArtifact: appDatabaseValidations.ownsArtifact })
      .from(appDatabaseValidations)
      .where(eq(appDatabaseValidations.operationId, claim.id));
    if (!ownership) throw new Error("Validation not found");
    ownsArtifact = ownership.ownsArtifact;
    await maintainValidationCleanupLease(database, claim);
    heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = (async (): Promise<void> => {
        try {
          lock.assertHeld();
          await maintainValidationCleanupLease(database, claim);
          if (!controller.signal.aborted) await held();
        } catch {
          abort();
        }
      })().finally(() => {
        renewal = undefined;
      });
    }, HEARTBEAT_MS);
    let input = await loadDatabaseValidation(database, claim);
    deadlineTimer = setTimeout(abort, input.remainingMs);
    if (ownsArtifact) {
      if (input.imageId !== null)
        throw new Error("Prepared work cannot be resumed automatically");
      await held();
      await recordDatabaseEffect(database, claim, {
        kind: "prepare-validation-artifact",
        id: `wrenly-artifact-${claim.id}`,
      });
      stage = "artifact preparation";
      const artifact = await (
        adapters.prepare ?? prepareDatabaseValidationArtifact
      )({
        deploymentId: claim.id,
        stack: input.framework,
        files: input.files,
        migrationDigest: input.migrationDigest,
        signal: controller.signal,
        beforeEffect: held,
      });
      await held();
      await acknowledgeValidationArtifact(database, claim, artifact.imageId);
      input = await loadDatabaseValidation(database, claim);
    }
    if (!input.imageId) throw new Error("Prepared image missing");
    stage = "disposable database validation";
    const result = await (
      adapters.validate ?? validateFreshDatabaseApplication
    )({
      ...input,
      imageId: input.imageId,
      projectId: claim.projectId,
      operationId: claim.id,
      sourceResourceId: claim.resourceId,
      signal: controller.signal,
      fence: {
        assertHeld: held,
        beforeEffect: async (effect) => {
          await held();
          await recordDatabaseEffect(database, claim, effect);
        },
        acknowledgeEffect: async (effect) => {
          await held();
          await acknowledgeDatabaseEffect(database, claim, effect.id);
        },
      },
      cleanup,
    });
    await held();
    stage = "artifact cleanup";
    await cleanupArtifact();
    await held();
    await finishDatabaseValidation(database, claim, { success: true, result });
    return { status: "success", result };
  } catch (error) {
    logger.error("Database application validation failed", {
      operationId: claim.id,
      projectId: claim.projectId,
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      artifactPhase:
        error instanceof RuntimeArtifactError &&
        [
          "setup",
          "source copy",
          "dependency installation",
          "offline compilation",
          "deployment identity marker",
          "image packaging",
          "image commit",
        ].includes(error.phase)
          ? error.phase
          : undefined,
    });
    try {
      await cleanupHeld();
      await (adapters.cleanup ?? cleanupDatabaseValidationResources)(
        {
          projectId: claim.projectId,
          resourceId: claim.id,
          environment: "development",
        },
        claim.id,
        claim.resourceId,
        cleanup,
      );
      await cleanupArtifact();
      const knownCompilationFailure =
        error instanceof RuntimeArtifactCompilationError &&
        error.operationId === claim.id &&
        stage === "artifact preparation" &&
        !controller.signal.aborted;
      if (knownCompilationFailure) {
        await held();
        await acknowledgeFailedValidationArtifact(database, claim, error);
      }
      await finishDatabaseValidation(database, claim, {
        success: false,
        errorCode: controller.signal.aborted
          ? "VALIDATION_CANCELLED"
          : "VALIDATION_FAILED",
      });
      return {
        status: "failed",
        ...(knownCompilationFailure ? { diagnostics: error.output } : {}),
      };
    } catch (error) {
      logger.error("Database validation cleanup needs review", {
        operationId: claim.id,
        projectId: claim.projectId,
        stage,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      await interruptDatabaseAction(database, claim);
      return { status: "interrupted" };
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (renewal) await renewal;
    signal.removeEventListener("abort", abort);
    await lock.release();
  }
}
