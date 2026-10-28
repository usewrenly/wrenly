/**
 * Durable publishing executor.
 * Called by the API worker after a claim is committed.
 * Uses a kernel lock, lease and per-mutation intent to publish one frozen revision; uncertain remote outcomes remain reserved for explicit reconciliation.
 */
import { validateLaravelSource } from "../../../../../../packages/sandbox/src/source-policy/laravel-runtime";

import type { db } from "@wrenly/db";
import type { ApiEnvironment } from "../../../config/api-environment";
import { logger } from "../../../lib/logger";
import { validateDeploymentSource } from "../policy/source-policy";
import { acquireDeploymentExecutorLock } from "./deployment-executor-lock";
import {
  loadDeploymentExecution,
  renewDeploymentLease,
  beginDeploymentMutation,
  completeDeploymentMutation,
  finishDeployment,
  markDeploymentVerifying,
  prepareDeploymentRuntimeEnvironment,
  type DeploymentClaim,
} from "../persistence/deployment-store";
import {
  createDeploymentProviderClient,
  DeploymentProviderError,
  type DeploymentProviderClient,
} from "../../../../../../packages/deploy/src/http/provider-client";
import {
  createPrivateRepository,
  readPrivateRepository,
} from "../../../../../../packages/deploy/src/providers/gitea/repositories";
import { pushPrivateSnapshot } from "../../../../../../packages/deploy/src/source-snapshots/git-transport";
import {
  buildRuntimeArtifact,
  type RuntimeArtifact,
} from "../../../../../../packages/sandbox/src/artifacts/runtime-artifact";
import { publishRuntimeArtifact } from "../../../../../../packages/sandbox/src/artifacts/artifact-registry";
import {
  createImageApplication,
  readImageApplication,
  updateImageApplication,
  triggerImageDeployment,
  readImageDeployment,
} from "../../../../../../packages/deploy/src/providers/coolify/image-application";
import { deliverRuntimeEnvironment } from "../../../../../../packages/deploy/src/providers/coolify/runtime-environment";
import { verifyDeploymentReadiness } from "../../../../../../packages/deploy/src/providers/coolify/readiness";

const HEARTBEAT_MS = 5000;
const EXECUTION_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 2000;
export interface DeploymentArtifactServices {
  build: typeof buildRuntimeArtifact;
  publish: typeof publishRuntimeArtifact;
  pushSource: typeof pushPrivateSnapshot;
  ready: typeof verifyDeploymentReadiness;
}
const services: DeploymentArtifactServices = {
  build: buildRuntimeArtifact,
  publish: publishRuntimeArtifact,
  pushSource: pushPrivateSnapshot,
  ready: verifyDeploymentReadiness,
};

/** Executes once; each uncertain acknowledgement remains fenced for explicit reconciliation. */
export async function executeDeployment(
  database: typeof db,
  claim: DeploymentClaim,
  environment: ApiEnvironment,
  shutdown: AbortSignal,
  adapters: DeploymentArtifactServices = services,
  providers?: {
    git: DeploymentProviderClient;
    coolify: DeploymentProviderClient;
  },
): Promise<void> {
  const lock = await acquireDeploymentExecutorLock(claim);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    shutdown,
    controller.signal,
    AbortSignal.timeout(EXECUTION_TIMEOUT_MS),
  ]);
  let heartbeat: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = renewDeploymentLease(database, claim)
      .catch(() => {
        controller.abort();
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, HEARTBEAT_MS);
  const fence = async (): Promise<void> => {
    signal.throwIfAborted();
    lock.assertHeld();
    await loadDeploymentExecution(database, claim);
    signal.throwIfAborted();
  };
  let stage = "snapshot_validation";
  try {
    const { deployment, resources } = await loadDeploymentExecution(
      database,
      claim,
    );
    if (
      !["nextjs", "laravel"].includes(deployment.stack) ||
      validateDeploymentSource(deployment.files).sha256 !==
        deployment.sourceSha256
    )
      throw new Error("Unsupported or changed deployment snapshot.");
    if (deployment.stack === "laravel") validateLaravelSource(deployment.files);
    if (
      resources.gitInstanceUrl !==
        new URL(environment.WRENLY_GIT_BASE_URL!).origin ||
      resources.coolifyInstanceUrl !==
        new URL(environment.WRENLY_COOLIFY_API_URL!).origin ||
      resources.registryOrigin !==
        new URL(environment.WRENLY_REGISTRY_URL!).origin ||
      resources.registryNamespace !== environment.WRENLY_REGISTRY_NAMESPACE ||
      resources.repositoryOwner !== environment.WRENLY_GIT_ORG ||
      resources.coolifyProjectUuid !==
        environment.WRENLY_COOLIFY_PROJECT_UUID ||
      resources.coolifyServerUuid !== environment.WRENLY_COOLIFY_SERVER_UUID ||
      resources.coolifyEnvironmentName !==
        environment.WRENLY_COOLIFY_ENVIRONMENT
    )
      throw new Error("Publishing target changed after admission.");
    const git =
      providers?.git ??
      createDeploymentProviderClient({
        origin: resources.gitInstanceUrl,
        token: environment.WRENLY_GIT_TOKEN!,
        authentication: "token",
      });
    const coolify =
      providers?.coolify ??
      createDeploymentProviderClient({
        origin: resources.coolifyInstanceUrl,
        token: environment.WRENLY_COOLIFY_API_KEY!,
        authentication: "Bearer",
      });
    stage = "source_identity";
    const identity = await git.request(
      "GET",
      "/api/v1/user",
      undefined,
      signal,
    );
    if (
      !identity ||
      typeof identity !== "object" ||
      !("login" in identity) ||
      typeof identity.login !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(identity.login)
    )
      throw new Error("Git token identity is invalid.");
    const repository = await readPrivateRepository(
      git,
      resources.repositoryOwner,
      resources.repositoryName,
      resources.repositoryId ?? undefined,
      signal,
    );
    if (repository && !resources.repositoryId)
      throw new Error("Unknown existing repository requires reconciliation.");
    if (!repository) {
      const intent = await beginDeploymentMutation(
        database,
        claim,
        "create_repository",
      );
      await fence();
      const created = await createPrivateRepository(
        git,
        resources.repositoryOwner,
        resources.repositoryName,
        signal,
      );
      await completeDeploymentMutation(database, claim, {
        ...intent,
        id: created.id,
      });
    }
    stage = "source_push";
    const sourceIntent = await beginDeploymentMutation(
      database,
      claim,
      "push_source",
    );
    await fence();
    const commitSha = await adapters.pushSource(
      {
        deploymentId: deployment.id,
        files: deployment.files,
        repositoryUrl: `${resources.gitInstanceUrl}/${resources.repositoryOwner}/${resources.repositoryName}.git`,
        username: identity.login,
        token: environment.WRENLY_GIT_TOKEN!,
      },
      signal,
    );
    await completeDeploymentMutation(database, claim, {
      ...sourceIntent,
      commitSha,
    });

    stage = "artifact_build";
    const artifactIntent = await beginDeploymentMutation(
      database,
      claim,
      "build_artifact",
    );
    const artifact: RuntimeArtifact = await adapters.build({
      deploymentId: deployment.id,
      stack: deployment.stack,
      files: deployment.files,
      signal,
      beforeEffect: fence,
    });
    await completeDeploymentMutation(database, claim, {
      ...artifactIntent,
      ...artifact,
    });
    stage = "artifact_push";
    const pushIntent = await beginDeploymentMutation(
      database,
      claim,
      "push_artifact",
    );
    const uploaded = await adapters.publish({
      deploymentId: deployment.id,
      imageId: artifact.imageId,
      origin: resources.registryOrigin!,
      namespace: resources.registryNamespace!,
      username: environment.WRENLY_REGISTRY_USERNAME!,
      password: environment.WRENLY_REGISTRY_PASSWORD!,
      signal,
      beforeEffect: fence,
    });
    await completeDeploymentMutation(database, claim, {
      ...pushIntent,
      ...uploaded,
    });
    stage = "application_configuration";
    const image = `${uploaded.repository}@${uploaded.digest}`;
    const name = `wrenly-${deployment.projectId}`;
    let applicationId = resources.coolifyApplicationUuid;
    if (applicationId) {
      await readImageApplication(coolify, applicationId, name, signal);
      const intent = await beginDeploymentMutation(
        database,
        claim,
        "update_application",
      );
      await fence();
      await updateImageApplication(coolify, applicationId, image, signal);
      await completeDeploymentMutation(database, claim, intent);
    } else {
      const intent = await beginDeploymentMutation(
        database,
        claim,
        "create_application",
      );
      await fence();
      applicationId = await createImageApplication(
        coolify,
        {
          name,
          image,
          projectUuid: resources.coolifyProjectUuid,
          serverUuid: resources.coolifyServerUuid,
          environmentName: resources.coolifyEnvironmentName,
        },
        signal,
      );
      await completeDeploymentMutation(database, claim, {
        ...intent,
        id: applicationId,
      });
    }
    if (
      (await readImageApplication(coolify, applicationId, name, signal))
        .image !== image
    )
      throw new Error("Application did not retain the immutable image.");
    stage = "runtime_environment";
    const runtime = await prepareDeploymentRuntimeEnvironment(
      database,
      claim,
      environment.WRENLY_DEPLOY_ENCRYPTION_KEY!,
    );
    if (Object.keys(runtime).length) {
      const intent = await beginDeploymentMutation(
        database,
        claim,
        "set_environment",
      );
      await fence();
      await deliverRuntimeEnvironment(coolify, applicationId, runtime, signal);
      await completeDeploymentMutation(database, claim, intent);
    }
    stage = "deployment_trigger";
    const trigger = await beginDeploymentMutation(
      database,
      claim,
      "trigger_deploy",
    );
    await fence();
    const jobId = await triggerImageDeployment(coolify, applicationId, signal);
    await completeDeploymentMutation(database, claim, {
      ...trigger,
      id: jobId,
    });
    stage = "deployment_readiness";
    let lastReadinessReason: string | undefined;
    let verifying = false;
    const reportReadiness = (reason: string): void => {
      if (reason === lastReadinessReason) return;
      lastReadinessReason = reason;
      logger.info("Deployment readiness check", {
        deploymentId: deployment.id,
        reason,
      });
    };
    while (true) {
      await fence();
      const status = await readImageDeployment(coolify, jobId, signal);
      if (status === "failed")
        throw new Error("Remote image deployment failed.");
      if (status === "success") {
        if (!verifying) { await markDeploymentVerifying(database, claim); verifying = true; }
        const app = await readImageApplication(
          coolify,
          applicationId,
          name,
          signal,
        );
        if (app.image !== image)
          throw new Error("Application image changed during deployment.");
        if (!app.url) reportReadiness("application_url_missing");
        if (
          app.url &&
          (await adapters.ready(
            app.url,
            deployment.id,
            signal,
            undefined,
            reportReadiness,
          ))
        ) {
          await finishDeployment(database, claim, {
            status: "success",
            url: app.url,
          });
          logger.info("Deployment execution finished", {
            deploymentId: deployment.id,
            outcome: "success",
          });
          return;
        }
      }
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          clearTimeout(wait);
          resolve();
        };
        const wait = setTimeout(() => {
          signal.removeEventListener("abort", stop);
          resolve();
        }, POLL_MS);
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      });
    }
  } catch (error) {
    logger.error("Deployment execution could not be confirmed", {
      deploymentId: claim.deploymentId,
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof DeploymentProviderError
        ? { providerCode: error.code, httpStatus: error.status }
        : {}),
    });
    // A saved remote job may still run after cancellation or a network failure.
    // Keep its project reserved until the operator verifies the exact remote job.
    try {
      const state = await loadDeploymentExecution(database, claim);
      await finishDeployment(database, claim, {
        status:
          state.deployment.remoteDeploymentUuid || signal.aborted
            ? "interrupted"
            : "failed",
        code:
          stage === "deployment_readiness"
            ? "READINESS_UNCONFIRMED"
            : signal.aborted
              ? "EXECUTION_INTERRUPTED"
              : stage === "artifact_build"
                ? "ARTIFACT_BUILD_FAILED"
                : stage === "artifact_push"
                  ? "REGISTRY_UPLOAD_UNCONFIRMED"
                  : stage === "source_identity" || stage === "source_push"
                    ? "SOURCE_SYNC_FAILED"
                    : stage === "application_configuration" ||
                        stage === "runtime_environment"
                      ? "APPLICATION_CONFIGURATION_FAILED"
                      : "PROVIDER_FAILURE",
      });
    } catch {
      /* Expired claims retain their reservation for fenced worker recovery. */
    }
  } finally {
    clearInterval(timer);
    await heartbeat;
    await lock.release();
  }
}
