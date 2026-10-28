/**
 * Server loop for saved conversation turns.
 * Claims and renews work independently of browser progress subscriptions, checks cancellation/deadlines and saves only validated outcomes.
 * Losing ownership or process interruption cannot authorize replaying the model request.
 */
import { BuildAdmissionError } from "../../builds/admission/build-admission";
import { ConversationStoreError } from "../persistence/conversation-store";
import type {
  ConversationClaim,
  ConversationFailureStatus,
} from "../persistence/conversation-store";
import type { ConversationContext } from "./conversation-context";
import type { ConversationDecision } from "../contracts/contracts";
import { ConversationContextError } from "./conversation-context";
import { ConversationModelError } from "./conversation-model";
import { logger } from "../../../lib/logger";

const MONITOR_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 1000;
export interface ConversationWorkerDependencies {
  claim: () => Promise<ConversationClaim | null>;
  renew: (claim: ConversationClaim) => Promise<boolean>;
  recover: () => Promise<boolean>;
  context: (claim: ConversationClaim) => Promise<ConversationContext>;
  infer: (
    claim: ConversationClaim,
    context: ConversationContext,
    signal: AbortSignal,
  ) => Promise<ConversationDecision>;
  complete: (
    claim: ConversationClaim,
    decision: ConversationDecision,
  ) => Promise<void>;
  fail: (
    claim: ConversationClaim,
    status: ConversationFailureStatus,
    message: string,
  ) => Promise<void>;
}
export interface ConversationWorkerTiming {
  monitorMs: number;
  pollMs: number;
  deadlineMs: number;
}

function logFailure(error: unknown): void {
  logger.error("Conversation worker operation failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

/** Settles one inference before admitting local work again, including abort and lease-monitor settlement. */
export async function runConversationWorkerCycle(
  dependencies: ConversationWorkerDependencies,
  shutdown: AbortSignal,
  timing: ConversationWorkerTiming,
): Promise<boolean> {
  let claim: ConversationClaim | null = null;
  let monitor: Promise<void> | undefined;
  let monitorTimer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let lost = false;
  let timedOut = false;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("API shutdown"));
  shutdown.addEventListener("abort", abort, { once: true });
  try {
    if (shutdown.aborted) return false;
    while (!shutdown.aborted && (await dependencies.recover())) {
      /* Never requeue expired inference. */
    }
    if (shutdown.aborted) return false;
    claim = await dependencies.claim();
    if (!claim) return false;
    const owned = claim;
    if (shutdown.aborted) abort();
    const check = async (): Promise<void> => {
      try {
        if (!(await dependencies.renew(owned))) {
          lost = true;
          controller.abort(new Error("Conversation claim lost"));
        }
      } catch (error) {
        lost = true;
        controller.abort(new Error("Conversation ownership unavailable"));
        logFailure(error);
      }
    };
    const checkOnce = (): Promise<void> => {
      if (!monitor)
        monitor = check().finally(() => {
          monitor = undefined;
        });
      return monitor;
    };
    monitorTimer = setInterval(() => {
      if (!controller.signal.aborted) void checkOnce();
    }, timing.monitorMs);
    deadline = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Conversation deadline"));
    }, timing.deadlineMs);
    controller.signal.throwIfAborted();
    const context = await dependencies.context(owned);
    await checkOnce();
    controller.signal.throwIfAborted();
    const decision = await dependencies.infer(
      owned,
      context,
      controller.signal,
    );
    await checkOnce();
    controller.signal.throwIfAborted();
    await dependencies.complete(owned, decision);
    return true;
  } catch (error) {
    if (claim && !lost) {
      const message = shutdown.aborted
        ? "The API stopped before this response was saved. Retry explicitly."
        : timedOut
          ? "The model response exceeded its deadline. Retry explicitly or select another model."
          : error instanceof ConversationModelError ||
              error instanceof ConversationContextError ||
              error instanceof BuildAdmissionError ||
              error instanceof ConversationStoreError
            ? error.message
            : "The conversation could not be completed. Review saved activity and retry explicitly.";
      try {
        await dependencies.fail(
          claim,
          shutdown.aborted ? "interrupted" : "failed",
          message,
        );
      } catch (failure) {
        logFailure(failure);
      }
    } else if (!shutdown.aborted && !lost) logFailure(error);
    return claim !== null;
  } finally {
    if (monitorTimer) clearInterval(monitorTimer);
    if (deadline) clearTimeout(deadline);
    shutdown.removeEventListener("abort", abort);
    await monitor;
  }
}

/** Owns serial inference independently of browser subscriptions; shutdown interrupts quiet polling. */
export async function runConversationWorker(
  dependencies: ConversationWorkerDependencies,
  shutdown: AbortSignal,
  deadlineMs: number,
  timing: Pick<ConversationWorkerTiming, "monitorMs" | "pollMs"> = {
    monitorMs: MONITOR_INTERVAL_MS,
    pollMs: POLL_INTERVAL_MS,
  },
): Promise<void> {
  try {
    while (!shutdown.aborted) {
      await runConversationWorkerCycle(dependencies, shutdown, {
        ...timing,
        deadlineMs,
      });
      if (shutdown.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          shutdown.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, timing.pollMs);
        shutdown.addEventListener("abort", finish, { once: true });
        if (shutdown.aborted) finish();
      });
    }
  } catch (error) {
    logFailure(error);
    throw new Error("Conversation worker stopped unexpectedly.", {
      cause: error,
    });
  }
}
