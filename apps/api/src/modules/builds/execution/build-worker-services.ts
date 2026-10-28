/**
 * Connecting saved-work storage to build execution.
 * Binds claim/progress/result functions to injected model, Docker and cleanup operations.
 * Importing or constructing these dependencies starts no work; tests can supply controlled adapters.
 */
import { BuildExecutionInterruptedError } from "./build-interruption";
import type { db } from "@wrenly/db";
import {
  claimNextBuild,
  renewBuildLease,
  isBuildCancellationRequested,
  reconcileExpiredBuild,
  finishBuild,
  recordBuildProgress,
  type BuildClaim,
} from "../persistence/build-job-store";
import {
  executeClaimedBuild,
  type BuildExecutorDependencies,
} from "./build-executor";
import type { BuildWorkerDependencies } from "./build-worker";

export interface BuildExecutionAdapters extends Omit<
  BuildExecutorDependencies,
  "progress"
> {
  cleanup: (claim: BuildClaim) => Promise<void>;
  /** Explicit false fences old selected jobs before inference when database execution is inactive. */
  databaseValidation?: boolean;
}

/** Wires durable execution without starting it; production adapters must implement abort/cleanup. */
export function createBuildWorkerDependencies(
  database: typeof db,
  adapters: BuildExecutionAdapters,
): BuildWorkerDependencies {
  return {
    claim: () => claimNextBuild(database),
    renew: (claim) => renewBuildLease(database, claim),
    cancellationRequested: (claim) =>
      isBuildCancellationRequested(database, claim),
    reconcile: () => reconcileExpiredBuild(database, adapters.cleanup),
    execute: async (claim, signal) => {
      if (claim.input.databaseV1 !== undefined && adapters.databaseValidation === false)
        throw new BuildExecutionInterruptedError();
      return executeClaimedBuild(claim, signal, {
        generate: adapters.generate,
        validate: adapters.validate,
        streamsValidationLogs: adapters.streamsValidationLogs,
        progress: (owned, progress) =>
          recordBuildProgress(database, owned, progress),
      });
    },
    cleanup: adapters.cleanup,
    finish: (claim, outcome) => finishBuild(database, claim, outcome),
  };
}
