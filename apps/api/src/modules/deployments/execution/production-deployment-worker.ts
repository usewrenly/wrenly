/**
 * API-owned publishing worker lifecycle.
 * Polls durable claims independently of HTTP subscriptions and waits for external processes to settle before recovery.
 * Shutdown stops admission/execution without silently replaying remote effects.
 */

import type { db } from "@wrenly/db";
import {
  deployments,
  deploymentResources,
  deploymentQueue,
} from "../../../../../../packages/db/src/schema";
import type { ApiEnvironment } from "../../../config/api-environment";
import { logger } from "../../../lib/logger";
import {
  claimNextDeployment,
  getExpiredDeploymentClaims,
  interruptQuiescentDeployment,
} from "../persistence/deployment-store";
import { acquireDeploymentExecutorLock } from "./deployment-executor-lock";
import { executeDeployment } from "./deployment-executor";
import { cleanupPrivateSnapshotWorkspace } from "../../../../../../packages/deploy/src/source-snapshots/git-transport";
import {
  cleanupRuntimeArtifactPreparation,
  verifyRuntimeArtifactHost,
} from "../../../../../../packages/sandbox/src/artifacts/runtime-artifact";
const POLL_MS = 2000;
// Host Git is additionally bounded by GNU timeout, which survives API termination.
// A lost claim is observed once, then allowed to settle beyond that external bound.
const RECOVERY_SETTLE_MS = 65_000;
export interface DeploymentWorkerLifecycle {
  done: Promise<void>;
  stop: () => Promise<void>;
}

/** Checks deployment migrations without altering an operator's database. */
export async function verifyDeploymentWorkerSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database
      .select({
        image: deployments.artifactImageId,
        digest: deployments.registryDigest,
      })
      .from(deployments)
      .limit(1);
    await database
      .select({ registry: deploymentResources.registryOrigin })
      .from(deploymentResources)
      .limit(1);
    await database.select().from(deploymentQueue).limit(1);
  } catch {
    throw new Error(
      "Publishing persistence is unavailable. Run bun run db:migrate from packages/db (through migration 0010).",
    );
  }
}

/** Starts opt-in image publishing; shutdown waits for the owned executor to stop. */
export async function startProductionDeploymentWorker(
  database: typeof db,
  environment: ApiEnvironment,
): Promise<DeploymentWorkerLifecycle> {
  await verifyDeploymentWorkerSchema(database);
  if (process.platform !== "linux")
    throw new Error(
      "Publishing currently requires Linux with Docker, git, timeout and flock.",
    );
  for (const command of ["git", "timeout", "flock"]) {
    if (!Bun.which(command))
      throw new Error(`Publishing requires ${command} in PATH.`);
  }
  await verifyRuntimeArtifactHost();
  const shutdown = new AbortController();
  const observed = new Map<string, number>();
  const done = (async (): Promise<void> => {
    while (!shutdown.signal.aborted) {
      try {
        for (const claim of await getExpiredDeploymentClaims(database)) {
          const key = `${claim.deploymentId}:${claim.token}`;
          const firstSeen = observed.get(key);
          if (!firstSeen) {
            observed.set(key, Date.now());
            continue;
          }
          if (Date.now() - firstSeen < RECOVERY_SETTLE_MS) continue;
          const lock = await acquireDeploymentExecutorLock(claim);
          try {
            await cleanupRuntimeArtifactPreparation(claim.deploymentId);
            await cleanupPrivateSnapshotWorkspace(claim.deploymentId);
            await interruptQuiescentDeployment(database, claim);
            observed.delete(key);
          } finally {
            await lock.release();
          }
        }
        if (!shutdown.signal.aborted) {
          const claim = await claimNextDeployment(database);
          if (claim)
            await executeDeployment(
              database,
              claim,
              environment,
              shutdown.signal,
            );
        }
      } catch (error) {
        logger.error("Publishing worker operation failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (!shutdown.signal.aborted)
        await new Promise<void>((resolve) => {
          const abort = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            shutdown.signal.removeEventListener("abort", abort);
            resolve();
          }, POLL_MS);
          shutdown.signal.addEventListener("abort", abort, { once: true });
          if (shutdown.signal.aborted) abort();
        });
    }
  })();
  return {
    done,
    stop: async () => {
      shutdown.abort();
      await done;
    },
  };
}
