import type { ProductionMaintenanceGrant } from "@wrenly/db/production-maintenance-contract";
/** Reconstructs runtime maintenance only from a saved successful publication and matching trusted instance settings. */
import { and, eq } from "drizzle-orm";
import { type db, deployments, deploymentResources } from "@wrenly/db";
import { createDeploymentProviderClient } from "@wrenly/deploy";
import type { ApiEnvironment } from "../../../config/api-environment";
import { logger } from "../../../lib/logger";
import { runMaintenanceClaim } from "./worker";
import { createMaintenanceServices } from "./services";
import {
  maintenanceScheduleStore,
  startMaintenanceScheduler,
} from "./scheduler";
import type { MaintenanceClaim } from "./claims";

/**
 * Resolves metadata without contacting a provider or loading application credentials.
 * Owner controls may pass an already-authorized paused/revoked grant for read-only
 * route inspection. Background callers must load their live enabled claim instead.
 */
export async function productionMaintenanceConfiguration(
  database: typeof db,
  environment: ApiEnvironment,
  claim: MaintenanceClaim,
  ownerControlGrant?: ProductionMaintenanceGrant,
): Promise<Parameters<typeof createMaintenanceServices>[0]> {
  const grant =
    ownerControlGrant ??
    (await loadMaintenanceAuthorityForClaim(database, claim));
  const [row] = await database
    .select({ publication: deployments, placement: deploymentResources })
    .from(deployments)
    .innerJoin(
      deploymentResources,
      eq(deploymentResources.projectId, deployments.projectId),
    )
    .where(
      and(
        eq(deployments.id, claim.deploymentId),
        eq(deployments.projectId, claim.projectId),
      ),
    );
  const publication = row?.publication,
    placement = row?.placement;
  const service = grant.publication.completed.find(
    (receipt) => receipt.fact.step === "service-create",
  )?.fact;
  if (
    grant.publication.completed[3]?.fact.step !== "broker-start" ||
    grant.publication.completed[3].fact.imageId !==
      environment.WRENLY_PRODUCTION_BROKER_IMAGE_ID ||
    !publication ||
    !placement ||
    publication.status !== "success" ||
    (publication.stack !== "nextjs" && publication.stack !== "laravel") ||
    !publication.artifactImageId ||
    !publication.registryRepository ||
    !publication.registryDigest ||
    service?.step !== "service-create" ||
    service.appImageId !== publication.artifactImageId ||
    service.appRegistryDigest !== publication.registryDigest ||
    !environment.WRENLY_COOLIFY_API_URL ||
    !environment.WRENLY_COOLIFY_API_KEY ||
    !environment.WRENLY_DEPLOY_ENCRYPTION_KEY ||
    placement.coolifyInstanceUrl !==
      new URL(environment.WRENLY_COOLIFY_API_URL).origin ||
    placement.coolifyServerUuid !== environment.WRENLY_COOLIFY_SERVER_UUID ||
    placement.coolifyProjectUuid !== environment.WRENLY_COOLIFY_PROJECT_UUID ||
    placement.coolifyEnvironmentName !==
      environment.WRENLY_COOLIFY_ENVIRONMENT ||
    !environment.WRENLY_PRODUCTION_INGRESS_IMAGE ||
    !environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID ||
    !environment.WRENLY_PRODUCTION_INGRESS_IMAGE.endsWith(
      `@${service.ingressRegistryDigest}`,
    )
  )
    throw new Error(
      "Saved runtime or configured publishing destination changed.",
    );
  return {
    database,
    claim,
    directory: environment.WRENLY_DATA_DIR,
    deploymentEncryptionKey: environment.WRENLY_DEPLOY_ENCRYPTION_KEY,
    client: createDeploymentProviderClient({
      origin: placement.coolifyInstanceUrl,
      token: environment.WRENLY_COOLIFY_API_KEY,
      authentication: "Bearer",
    }),
    images: {
      framework: publication.stack,
      appImageId: publication.artifactImageId,
      appImage: `${publication.registryRepository}@${publication.registryDigest}`,
      ingressImage: environment.WRENLY_PRODUCTION_INGRESS_IMAGE,
    },
    ingressImageId: environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID,
    assertHeld: async () => {
      throw new Error("A held worker is required.");
    },
  };
}
// A claimed attempt is itself a blocker; only its exact token may exclude that blocker.
async function loadMaintenanceAuthorityForClaim(
  database: typeof db,
  claim: MaintenanceClaim,
) {
  const { loadMaintenanceClaim } = await import("./claims");
  return (await loadMaintenanceClaim(database, claim)).grant;
}
/** Called only after Production's image and server startup checks; no grant means no host operation. */
export function startProductionMaintenance(
  database: typeof db,
  environment: ApiEnvironment,
): ReturnType<typeof startMaintenanceScheduler> {
  if (
    environment.WRENLY_PRODUCTION_DATABASES_ENABLED !== "true" ||
    environment.WRENLY_PUBLISHING_ENABLED !== "true"
  )
    throw new Error("Production maintenance is disabled.");
  return startMaintenanceScheduler({
    ...maintenanceScheduleStore(database),
    failed: () => logger.info("Published runtime maintenance needs review"),
    run: async (claim, signal) => {
      // The kernel lock and lease must surround configuration reads and every subsequent effect.
      await runMaintenanceClaim({
        database,
        claim,
        signal,
        services: (assertHeld) => {
          let configuration:
            | Promise<Parameters<typeof createMaintenanceServices>[0]>
            | undefined;
          const configured = async () => {
            configuration ??= productionMaintenanceConfiguration(
              database,
              environment,
              claim,
            );
            return createMaintenanceServices({
              ...(await configuration),
              assertHeld,
            });
          };
          return {
            assertHeld,
            load: async () => (await configured()).load(),
            begin: async () => (await configured()).begin(),
            acknowledge: async (id) => (await configured()).acknowledge(id),
            perform: async (input) => (await configured()).perform(input),
          };
        },
      });
    },
  });
}
