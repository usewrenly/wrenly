/** Bridge artifact preparation and private promotion to the saved Production runtime, without activating a worker. */
import type { db } from "@wrenly/db";
import type { DeploymentProviderClient } from "@wrenly/deploy";
import {
  prepareProductionDatabaseArtifact,
  type RuntimeArtifact,
} from "@wrenly/sandbox/runtime-artifact";
import type { DeploymentClaim } from "../persistence/deployment-store";
import { getDatabaseWorkerBundle } from "../../databases/database-worker-bundle";
import { createProductionRuntimeServices } from "./services";
import { executeProductionRuntimeCoordinator } from "./executor";
export interface ProductionDeploymentServices {
  prepare: (
    input: Omit<
      Parameters<typeof prepareProductionDatabaseArtifact>[0],
      "bootstrap"
    >,
  ) => Promise<RuntimeArtifact>;
  run: (input: {
    database: typeof db;
    claim: DeploymentClaim;
    directory: string;
    deploymentEncryptionKey: string;
    client: DeploymentProviderClient;
    artifact: RuntimeArtifact;
    uploaded: { repository: string; digest: string };
    stack: "nextjs" | "laravel";
    placement: {
      projectUuid: string;
      serverUuid: string;
      environmentName: string;
    };
    assertHeld: () => Promise<void>;
    signal: AbortSignal;
  }) => Promise<string>;
}
/** Trusted image identities are supplied by installation verification, never browser input or generated source. */
export function createProductionDeploymentServices(images: {
  brokerImageId: string;
  ingressImageId: string;
  ingressImage: string;
}): ProductionDeploymentServices {
  const pinned = Object.freeze({ ...images });
  if (
    !/^sha256:[a-f0-9]{64}$/.test(pinned.brokerImageId) ||
    !/^sha256:[a-f0-9]{64}$/.test(pinned.ingressImageId) ||
    !/^[a-z0-9.:-]+\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/.test(
      pinned.ingressImage,
    )
  )
    throw new Error(
      "Verify the pinned Production broker and HTTP relay images before publishing.",
    );
  return {
    prepare: async (input) => {
      try {
        return await prepareProductionDatabaseArtifact({
          ...input,
          bootstrap: await getDatabaseWorkerBundle("production"),
        });
      } catch {
        throw new Error(
          "Production artifact preparation could not be confirmed.",
        );
      }
    },
    run: async (input) => {
      try {
        return await executeProductionRuntimeCoordinator(
          createProductionRuntimeServices({
            ...input,
            ...pinned,
            images: {
              framework: input.stack,
              appImageId: input.artifact.imageId,
              appImage: `${input.uploaded.repository}@${input.uploaded.digest}`,
              ingressImage: pinned.ingressImage,
            },
          }),
          input.signal,
        );
      } catch {
        throw new Error(
          "Production runtime could not be confirmed. Review its saved effect before continuing.",
        );
      }
    },
  };
}

/** Fixed guardian settings must not silently discard a project's custom runtime configuration. */
export function assertProductionRuntimeEnvironment(
  stack: "nextjs" | "laravel",
  settings: Record<string, string>,
): void {
  const defaults: Record<string, string> =
    stack === "laravel"
      ? {
          APP_ENV: "production",
          APP_DEBUG: "false",
          LOG_CHANNEL: "stderr",
          SESSION_DRIVER: "file",
          CACHE_STORE: "array",
          QUEUE_CONNECTION: "sync",
        }
      : {};
  if (
    Object.entries(settings).some(([key, value]) =>
      key === "APP_KEY" && stack === "laravel"
        ? !/^base64:[A-Za-z0-9+/]{43}=$/.test(value)
        : defaults[key] !== value,
    ) ||
    Object.keys(defaults).some((key) => settings[key] !== defaults[key]) ||
    (stack === "laravel" && !settings.APP_KEY)
  )
    throw new Error(
      "Review unsupported custom runtime settings before database-backed publishing.",
    );
}
