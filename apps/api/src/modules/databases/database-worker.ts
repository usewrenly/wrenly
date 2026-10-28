// Execution belongs to the API lifecycle; a browser subscription never owns or retries it.
import type { DatabaseClaim } from "./database-store";
const POLL_MS = 1000;
const HEARTBEAT_MS = 5000;
const DEADLINE_MS = 5 * 60_000;
export interface DatabaseWorkerDependencies {
  recoverExpired: () => Promise<void>;
  claim: () => Promise<DatabaseClaim | null>;
  renew: (claim: DatabaseClaim) => Promise<void>;
  execute: (
    claim: DatabaseClaim,
    signal: AbortSignal,
  ) => Promise<"success" | "failed">;
  interrupt: (claim: DatabaseClaim) => Promise<void>;
  log: (message: string, context: Record<string, unknown>) => void;
  pollMs?: number;
  heartbeatMs?: number;
}
/** Serial executor with lease renewal; interrupted effects are never requeued or retried here. */
export function startDatabaseWorker(dependencies: DatabaseWorkerDependencies): {
  stop: () => Promise<void>;
} {
  let stopping = false,
    active: AbortController | undefined,
    wake: (() => void) | undefined;
  async function execute(claim: DatabaseClaim): Promise<void> {
    const controller = new AbortController();
    active = controller;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = dependencies
        .renew(claim)
        .catch(() => controller.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      if (stopping) controller.abort();
      controller.signal.throwIfAborted();
      const outcome = await dependencies.execute(claim, controller.signal);
      dependencies.log("Database execution finished", {
        operationId: claim.id,
        projectId: claim.projectId,
        outcome,
      });
    } catch {
      // execute must finish helper/container cleanup before returning. An unknown
      // commit or cancelled DDL stays fenced until explicit reconciliation.
      try {
        await dependencies.interrupt(claim);
      } catch {
        dependencies.log("Database interruption could not be recorded", {
          operationId: claim.id,
        });
      }
      dependencies.log("Database execution finished", {
        operationId: claim.id,
        projectId: claim.projectId,
        outcome: "interrupted",
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      if (renewal) await renewal;
      active = undefined;
    }
  }
  async function run(): Promise<void> {
    while (!stopping) {
      try {
        await dependencies.recoverExpired();
        const claim = await dependencies.claim();
        if (claim) {
          await execute(claim);
          continue;
        }
      } catch {
        dependencies.log("Database queue could not be checked", {});
      }
      if (!stopping)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, dependencies.pollMs ?? POLL_MS);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
    }
  }
  const running = run();
  return {
    stop: async () => {
      stopping = true;
      active?.abort();
      wake?.();
      await running;
    },
  };
}
