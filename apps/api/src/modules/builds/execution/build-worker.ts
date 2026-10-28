/**
 * Server loop for queued builds.
 * Picks one claim, renews ownership and checks cancellation while work runs.
 * Cleanup completes before a result or another claim; browser disconnects do not own this loop.
 * Lost ownership cannot be converted into a new execution.
 */
import type { BuildClaim, BuildOutcome } from "../persistence/build-job-store";
import { logger } from "../../../lib/logger";
import { BuildExecutionInterruptedError } from "./build-interruption";

const LEASE_MONITOR_INTERVAL_MS = 5000;
const QUEUE_POLL_INTERVAL_MS = 1000;
const SHUTDOWN_MESSAGE =
  "The API stopped before this build completed. Retry explicitly.";
const EXECUTION_ERROR_MESSAGE =
  "Build execution encountered an unexpected error. Review the saved diagnostics.";

export interface BuildWorkerDependencies {
  claim: () => Promise<BuildClaim | null>;
  renew: (claim: BuildClaim) => Promise<boolean>;
  cancellationRequested: (claim: BuildClaim) => Promise<boolean>;
  reconcile: () => Promise<boolean>;
  execute: (claim: BuildClaim, signal: AbortSignal) => Promise<BuildOutcome>;
  cleanup: (claim: BuildClaim) => Promise<void>;
  finish: (claim: BuildClaim, outcome: BuildOutcome) => Promise<void>;
}

export interface BuildWorkerTiming {
  monitorIntervalMs: number;
  pollIntervalMs: number;
}

const DEFAULT_TIMING: BuildWorkerTiming = {
  monitorIntervalMs: LEASE_MONITOR_INTERVAL_MS,
  pollIntervalMs: QUEUE_POLL_INTERVAL_MS,
};

function logWorkerFailure(
  operation: string,
  error: unknown,
  buildId?: string,
): void {
  logger.error(operation, {
    buildId,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

/** Runs one claim to settlement; cleanup/ownership failures deliberately leave it recoverable. */
export async function runBuildWorkerCycle(
  dependencies: BuildWorkerDependencies,
  shutdown: AbortSignal,
  timing: BuildWorkerTiming = DEFAULT_TIMING,
): Promise<boolean> {
  if (shutdown.aborted) return false;
  let claim: BuildClaim | null = null;
  try {
    // A failed cleanup must prevent this process from advancing to another claim.
    while (!shutdown.aborted && (await dependencies.reconcile())) {
      /* Drain expired work. */
    }
    if (shutdown.aborted) return false;
    claim = await dependencies.claim();
    if (!claim) return false;
    const owned = claim;
    logger.info("Build execution claimed", {
      buildId: owned.buildId,
      projectId: owned.projectId,
    });
    const controller = new AbortController();
    let leaseLost = false;
    let cancellationRequested = false;
    let monitorInFlight: Promise<void> | undefined;
    const onShutdown = (): void =>
      controller.abort(new Error(SHUTDOWN_MESSAGE));
    shutdown.addEventListener("abort", onShutdown, { once: true });
    // Shutdown can race the asynchronous claim operation.
    if (shutdown.aborted) onShutdown();
    const monitor = async (): Promise<void> => {
      try {
        if (!(await dependencies.renew(owned))) {
          leaseLost = true;
          controller.abort(new Error("Build lease lost."));
          return;
        }
        if (await dependencies.cancellationRequested(owned)) {
          cancellationRequested = true;
          controller.abort(new Error("Build cancelled."));
        }
      } catch (error) {
        leaseLost = true;
        controller.abort(new Error("Build ownership could not be verified."));
        logWorkerFailure("Build worker monitor failed", error, owned.buildId);
      }
    };
    const startMonitor = (): Promise<void> => {
      if (monitorInFlight) return monitorInFlight;
      monitorInFlight = monitor().finally(() => {
        monitorInFlight = undefined;
      });
      return monitorInFlight;
    };
    const timer = setInterval(() => {
      if (!leaseLost) void startMonitor();
    }, timing.monitorIntervalMs);
    let outcome: BuildOutcome;
    try {
      // Verify ownership/cancel intent before performing the first external effect.
      await startMonitor();
      if (controller.signal.aborted) throw controller.signal.reason;
      outcome = await dependencies.execute(owned, controller.signal);
      if (outcome.status !== "success" && controller.signal.aborted) {
        if (shutdown.aborted)
          outcome = { status: "interrupted", error: SHUTDOWN_MESSAGE };
        else if (cancellationRequested) outcome = { status: "cancelled" };
      }
    } catch (error) {
      outcome = shutdown.aborted
        ? { status: "interrupted", error: SHUTDOWN_MESSAGE }
        : cancellationRequested
          ? { status: "cancelled" }
          : error instanceof BuildExecutionInterruptedError
            ? { status: "interrupted", error: error.message }
          : { status: "failed", error: EXECUTION_ERROR_MESSAGE };
      if (!controller.signal.aborted)
        logWorkerFailure("Build worker execution failed", error, owned.buildId);
    } finally {
      try {
        // Retain lease monitoring during cleanup so another worker cannot take over.
        await dependencies.cleanup(owned);
      } finally {
        clearInterval(timer);
        shutdown.removeEventListener("abort", onShutdown);
        await monitorInFlight;
      }
    }
    if (leaseLost) return true;
    await dependencies.finish(owned, outcome);
    logger.info("Build execution finished", {
      buildId: owned.buildId,
      outcome: outcome.status,
    });
    return true;
  } catch (error) {
    logWorkerFailure("Build worker cycle failed", error, claim?.buildId);
    throw error;
  }
}

function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(onAbort, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls sequentially until shutdown; errors back off without replaying a claimed execution. */
export async function runBuildWorker(
  dependencies: BuildWorkerDependencies,
  shutdown: AbortSignal,
  timing: BuildWorkerTiming = DEFAULT_TIMING,
): Promise<void> {
  if (timing.monitorIntervalMs <= 0 || timing.pollIntervalMs <= 0)
    throw new Error("Worker timing intervals must be positive.");
  while (!shutdown.aborted) {
    try {
      const ran = await runBuildWorkerCycle(dependencies, shutdown, timing);
      if (ran) continue;
    } catch {
      // The cycle logs context; claims remain persisted for recovery, never requeued here.
    }
    await waitForPoll(shutdown, timing.pollIntervalMs);
  }
}
