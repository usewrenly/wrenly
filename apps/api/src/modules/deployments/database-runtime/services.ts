/** Connect the saved publishing journal to real adapters; startup activation remains the caller's separate responsibility. */
import type { db } from "@wrenly/db";
import type { DeploymentProviderClient } from "@wrenly/deploy";
import { z } from "zod";
import type { DeploymentClaim } from "../persistence/deployment-store";
import {
  loadProductionPublishingRuntime,
  beginProductionRuntimeEffect,
  acknowledgeProductionRuntimeEffect,
} from "./store";
import { loadProductionPublishingRuntimeSecrets } from "./secrets";
import {
  executeProductionHostEffect,
  discoverProductionApplication,
  executeProductionApplicationEffect,
} from "./host-adapter";
import {
  executeProductionServiceEffect,
  type ProductionServiceImages,
} from "./service-adapter";
import { verifyProductionRouteEffect } from "./route-adapter";
import type { ProductionRuntimeCoordinator } from "./executor";
const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 1000;
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error("Production readiness was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, READINESS_POLL_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** The worker must supply its kernel-lock/lease fence and already verified artifact identities. No environment or provider is inferred here. */
export function createProductionRuntimeServices(input: {
  database: typeof db;
  claim: DeploymentClaim;
  directory: string;
  deploymentEncryptionKey: string;
  client: DeploymentProviderClient;
  images: ProductionServiceImages;
  brokerImageId: string;
  ingressImageId: string;
  placement: {
    projectUuid: string;
    serverUuid: string;
    environmentName: string;
  };
  assertHeld: () => Promise<void>;
}): ProductionRuntimeCoordinator {
  const brokerImageId = ImageId.parse(input.brokerImageId),
    ingressImageId = ImageId.parse(input.ingressImageId);
  // Keep one execution's adapter configuration stable even if a caller later mutates its settings object.
  const images = structuredClone(input.images),
    placement = structuredClone(input.placement);
  return {
    load: () => loadProductionPublishingRuntime(input.database, input.claim),
    begin: () => beginProductionRuntimeEffect(input.database, input.claim),
    acknowledge: (receipt) =>
      acknowledgeProductionRuntimeEffect(input.database, input.claim, receipt),
    assertHeld: input.assertHeld,
    perform: async (effectInput) => {
      await input.assertHeld();
      effectInput.signal.throwIfAborted();
      const credentials = await loadProductionPublishingRuntimeSecrets(input);
      const selected = { ...effectInput, credentials };
      switch (effectInput.effect.step) {
        case "http-volume":
        case "database-volume":
        case "broker-network":
        case "broker-start":
          return executeProductionHostEffect({ ...selected, brokerImageId });
        case "service-create":
        case "service-start":
          return executeProductionServiceEffect({
            ...effectInput,
            client: input.client,
            images,
            placement,
          });
        case "application-start": {
          const signal = AbortSignal.any([
            effectInput.signal,
            AbortSignal.timeout(READINESS_TIMEOUT_MS),
          ]);
          let containerId: string | undefined;
          while (!containerId) {
            await input.assertHeld();
            signal.throwIfAborted();
            // Only discovery is repeated. Credential delivery below is a single saved mutation.
            try {
              containerId = await discoverProductionApplication({
                ...selected,
                signal,
              });
            } catch {
              signal.throwIfAborted();
              await pause(signal);
            }
          }
          await input.assertHeld();
          signal.throwIfAborted();
          return executeProductionApplicationEffect({
            ...selected,
            signal,
            framework: images.framework,
            containerId,
          });
        }
        case "route-verify": {
          const signal = AbortSignal.any([
            effectInput.signal,
            AbortSignal.timeout(READINESS_TIMEOUT_MS),
          ]);
          while (true) {
            await input.assertHeld();
            signal.throwIfAborted();
            const proof = await verifyProductionRouteEffect({
              ...selected,
              signal,
              client: input.client,
              images,
              ingressImageId,
              assertHeld: input.assertHeld,
            });
            if (proof) return proof;
            await pause(signal);
          }
        }
      }
    },
  };
}
