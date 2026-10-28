/**
 * Operator-only publishing reconciliation command.
 * Requires explicit confirmation and verifies saved remote identities after local work settles.
 * It does not retry publishing or provide an HTTP administrative bypass.
 */

import { z } from "zod";
import { parseApiEnvironment } from "../../../config/api-environment";
import { logger } from "../../../lib/logger";
import {
  loadInterruptedDeployment,
  finishInterruptedReconciliation,
} from "../persistence/reconciliation-store";
import { acquireDeploymentExecutorLock } from "../execution/deployment-executor-lock";
import { cleanupPrivateSnapshotWorkspace } from "../../../../../../packages/deploy/src/source-snapshots/git-transport";
import {
  cleanupRuntimeArtifactPreparation,
  cleanupUnacknowledgedArtifactImages,
} from "../../../../../../packages/sandbox/src/artifacts/runtime-artifact";
import { createDeploymentProviderClient } from "../../../../../../packages/deploy/src/http/provider-client";
import { readPrivateRepository } from "../../../../../../packages/deploy/src/providers/gitea/repositories";
import { readImageApplication } from "../../../../../../packages/deploy/src/providers/coolify/image-application";

if (import.meta.main) {
  let lock:
    Awaited<ReturnType<typeof acquireDeploymentExecutorLock>> | undefined;
  try {
    const [id, confirmation, applicationId, suppliedJobId] = Bun.argv.slice(2);
    if (
      !z.string().uuid().safeParse(id).success ||
      confirmation !== "--confirm-remote-settled"
    )
      throw new Error(
        "Usage: bun run reconcile-deployment DEPLOYMENT_UUID --confirm-remote-settled [LOST_APPLICATION_UUID|-] [LOST_JOB_UUID|-]",
      );
    const environment = parseApiEnvironment({
      ...process.env,
      WRENLY_PUBLISHING_ENABLED: "true",
    });
    if (
      ![environment.WRENLY_GIT_TOKEN, environment.WRENLY_COOLIFY_API_KEY].every(
        Boolean,
      )
    )
      throw new Error(
        "Configure publishing provider credentials before reconciliation.",
      );
    const { db } = await import("@wrenly/db");
    const original = await loadInterruptedDeployment(db, id!);
    lock = await acquireDeploymentExecutorLock({
      deploymentId: id!,
      token: crypto.randomUUID(),
    });
    const { deployment, resources } = original;
    if (
      resources.gitInstanceUrl !==
        new URL(environment.WRENLY_GIT_BASE_URL!).origin ||
      resources.coolifyInstanceUrl !==
        new URL(environment.WRENLY_COOLIFY_API_URL!).origin
    )
      throw new Error(
        "Restore the operation’s pinned provider configuration before reconciliation.",
      );
    await cleanupRuntimeArtifactPreparation(id!);
    await cleanupPrivateSnapshotWorkspace(id!);
    const signal = AbortSignal.timeout(30_000);
    const git = createDeploymentProviderClient({
      origin: resources.gitInstanceUrl,
      token: environment.WRENLY_GIT_TOKEN!,
      authentication: "token",
    });
    const repository = await readPrivateRepository(
      git,
      resources.repositoryOwner,
      resources.repositoryName,
      resources.repositoryId ?? undefined,
      signal,
    );
    if (
      !repository &&
      (resources.repositoryId ||
        resources.coolifyApplicationUuid ||
        deployment.remoteDeploymentUuid ||
        (deployment.mutationIntent &&
          deployment.mutationIntent.kind !== "create_repository"))
    )
      throw new Error(
        "Restore the saved private repository before reconciliation.",
      );
    if (
      repository &&
      !resources.repositoryId &&
      deployment.mutationIntent?.kind !== "create_repository"
    )
      throw new Error("Cannot adopt an unknown repository for this operation.");
    const coolify = createDeploymentProviderClient({
      origin: resources.coolifyInstanceUrl,
      token: environment.WRENLY_COOLIFY_API_KEY!,
      authentication: "Bearer",
    });
    const appId =
      resources.coolifyApplicationUuid ??
      (applicationId && applicationId !== "-" ? applicationId : null);
    if (deployment.mutationIntent?.kind === "create_application" && !appId)
      throw new Error(
        "Supply the exact application UUID created by the interrupted operation.",
      );
    if (
      !resources.coolifyApplicationUuid &&
      appId &&
      deployment.mutationIntent?.kind !== "create_application"
    )
      throw new Error("Cannot adopt an application for this operation.");
    if (appId) {
      const application = await readImageApplication(
        coolify,
        appId,
        `wrenly-${deployment.projectId}`,
        signal,
      );
      if (
        deployment.mutationIntent?.kind === "create_application" &&
        application.image !==
          `${deployment.registryRepository}@${deployment.registryDigest}`
      )
        throw new Error(
          "Created application does not reference this operation’s artifact.",
        );
    }
    const jobId =
      deployment.remoteDeploymentUuid ??
      (suppliedJobId && suppliedJobId !== "-" ? suppliedJobId : null);
    if (deployment.mutationIntent?.kind === "trigger_deploy" && !jobId)
      throw new Error(
        "Supply the exact terminal deployment job UUID; an unknown trigger cannot be cleared.",
      );
    if (
      !deployment.remoteDeploymentUuid &&
      jobId &&
      deployment.mutationIntent?.kind !== "trigger_deploy"
    )
      throw new Error("Cannot adopt a job for this operation.");
    if (jobId) {
      if (!appId || !/^[a-zA-Z0-9_-]{1,100}$/.test(jobId))
        throw new Error("Invalid remote job identity.");
      const job = await coolify.request(
        "GET",
        `/api/v1/deployments/${jobId}`,
        undefined,
        signal,
      );
      if (
        !job ||
        typeof job !== "object" ||
        !("deployment_uuid" in job) ||
        job.deployment_uuid !== jobId ||
        !("application_name" in job) ||
        job.application_name !== `wrenly-${deployment.projectId}` ||
        !("status" in job) ||
        ![
          "finished",
          "failed",
          "cancelled",
          "canceled",
          "cancelled-by-user",
        ].includes(String(job.status))
      )
        throw new Error(
          "The exact job is not confirmed terminal for this application.",
        );
    }
    if (!deployment.artifactImageId)
      await cleanupUnacknowledgedArtifactImages(id!);
    await finishInterruptedReconciliation(db, original, {
      repositoryId: repository?.id ?? null,
      applicationId: appId,
      jobId,
    });
    logger.info(
      "Publishing operation reconciled; explicit new publishing is now permitted",
      { deploymentId: id },
    );
  } catch (error) {
    logger.error("Publishing reconciliation retained its reservation", {
      message:
        error instanceof Error && !("query" in error)
          ? error.message
          : "Persistence could not be verified.",
    });
    process.exitCode = 1;
  } finally {
    await lock?.release();
    process.exit(process.exitCode ?? 0);
  }
}
