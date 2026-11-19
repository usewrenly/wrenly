/** Joins persisted maintenance authority to exact host and read-only public-route adapters. */
import type { db } from "@wrenly/db";
import type { DeploymentProviderClient } from "@wrenly/deploy";
import type { MaintenanceExecutionServices } from "./executor";
import {
  loadMaintenanceClaim,
  lockMaintenanceClaim,
  advanceMaintenance,
  type MaintenanceClaim,
} from "./claims";
import { loadAuthorizedRuntimeSecrets } from "../database-runtime/secrets";
import { performMaintenanceHostEffect } from "./host-adapter";
import { verifyMaintainedProductionRoute } from "../database-runtime/route-adapter";
import type { ProductionServiceImages } from "../database-runtime/service-adapter";
/** Configuration comes from verified saved publication images and trusted worker setup, never browser input. */
export function createMaintenanceServices(input: {
  database: typeof db;
  claim: MaintenanceClaim;
  directory: string;
  deploymentEncryptionKey: string;
  client: DeploymentProviderClient;
  images: ProductionServiceImages;
  ingressImageId: string;
  assertHeld: () => Promise<void>;
}): MaintenanceExecutionServices {
  const images = structuredClone(input.images);
  return {
    load: () => loadMaintenanceClaim(input.database, input.claim),
    begin: () => advanceMaintenance(input.database, input.claim),
    acknowledge: (id) => advanceMaintenance(input.database, input.claim, id),
    assertHeld: input.assertHeld,
    perform: async (effect) => {
      await input.assertHeld();
      effect.signal.throwIfAborted();
      const credentials = await loadAuthorizedRuntimeSecrets({
        ...input,
        authorize: async (tx) =>
          (await lockMaintenanceClaim(tx, input.claim)).grant.binding,
      });
      if (effect.effect.step !== "route-verify")
        return performMaintenanceHostEffect({
          ...effect,
          credentials,
          framework: images.framework,
          claimToken: input.claim.token,
          assertHeld: input.assertHeld,
        });
      const result = await verifyMaintainedProductionRoute({
        ...effect,
        credentials,
        client: input.client,
        images,
        ingressImageId: input.ingressImageId,
        claimToken: input.claim.token,
        assertHeld: input.assertHeld,
      });
      const published = effect.grant.publication.completed.at(-1)?.fact;
      if (
        !result ||
        published?.step !== "route-verify" ||
        result.step !== "route-verify" ||
        result.url !== published.url ||
        result.sourceSha256 !== published.sourceSha256
      )
        throw new Error(
          "The original published route could not be verified after maintenance.",
        );
    },
  };
}
