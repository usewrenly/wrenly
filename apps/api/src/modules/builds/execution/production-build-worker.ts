/**
 * Production build worker startup and shutdown.
 * Checks required storage, connects real MCP/Docker operations and forwards validation logs.
 * Explicit stop waits for worker cleanup; no browser request or module import starts a second executor.
 */
import type { db } from "@wrenly/db";
import {
  buildJobs,
  buildEvents,
  buildQueue,
} from "../../../../../../packages/db/src/schema";
import { createDatabaseBuildValidator } from "../../databases/validation/build-validator";
import type { BuildExecutorDependencies } from "./build-executor";
import { runSandbox, cleanupSandboxClaim } from "@wrenly/sandbox";
import { callAgent } from "../../mcp/agent-client";
import { createBuildWorkerDependencies } from "./build-worker-services";
import { runBuildWorker } from "./build-worker";
import { createBuildLogBatcher } from "../http/build-log-batcher";
import { recordBuildProgress } from "../persistence/build-job-store";

export interface BuildWorkerLifecycle {
  done: Promise<void>;
  stop: () => Promise<void>;
}

/** Verifies required persistence before starting; never auto-migrates a user database. */
export async function verifyBuildWorkerSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select({ id: buildJobs.buildId }).from(buildJobs).limit(1);
    await database
      .select({ sequence: buildEvents.sequence })
      .from(buildEvents)
      .limit(1);
    await database.select({ id: buildQueue.id }).from(buildQueue).limit(1);
  } catch {
    throw new Error(
      "Build worker persistence is unavailable. Check PostgreSQL and run bun run db:migrate from packages/db before starting the worker.",
    );
  }
}

/** Starts the production worker explicitly; caller must preflight schema and await stop during shutdown. */
export async function startProductionBuildWorker(
  database: typeof db,
  options: { databaseValidation?: boolean } = {},
): Promise<BuildWorkerLifecycle> {
  await verifyBuildWorkerSchema(database);
  const shutdown = new AbortController();
  const validate: BuildExecutorDependencies["validate"] = async (files, claim, signal, attempt) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const logs = createBuildLogBatcher(
      (text) =>
        recordBuildProgress(database, claim, {
          type: "log_line",
          attempt,
          line: text,
        }),
      (error) => controller.abort(error),
    );
    try {
      return await runSandbox({
        files,
        projectId: claim.projectId,
        stack: claim.input.stack,
        buildId: claim.buildId,
        claimToken: claim.token,
        signal: controller.signal,
        onOutput: logs.write,
        onStage: (operation, state) =>
          recordBuildProgress(database, claim, {
            type: "activity_v1",
            attempt,
            operation,
            state,
          }),
      });
    } finally {
      signal.removeEventListener("abort", abort);
      await logs.drain();
    }
  };
  const validateSelected = options.databaseValidation ? createDatabaseBuildValidator(database, validate) : validate;
  const dependencies = createBuildWorkerDependencies(database, {
    generate: (stack, input, signal) => callAgent(stack, input, signal),
    streamsValidationLogs: true,
    databaseValidation: options.databaseValidation === true,
    validate: async (files, claim, signal, attempt) => {
      const result = await validateSelected(files, claim, signal, attempt);
      if (options.databaseValidation && claim.input.databaseV1 !== undefined && result.output)
        await recordBuildProgress(database, claim, { type: "log_line", attempt, line: result.output });
      return result;
    },
    cleanup: (claim) => cleanupSandboxClaim(claim.buildId, claim.token),
  });
  const done = runBuildWorker(dependencies, shutdown.signal);
  return {
    done,
    stop: async () => {
      try {
        shutdown.abort(new Error("API shutdown requested."));
        await done;
      } catch (error) {
        throw new Error("Build worker shutdown failed.", { cause: error });
      }
    },
  };
}
