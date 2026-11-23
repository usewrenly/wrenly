/** Reconstruct expected recovery images from saved artifact/placement and the unchanged trusted installation. */
import type { db } from "@wrenly/db";
import { createDeploymentProviderClient } from "@wrenly/deploy";
import type { ApiEnvironment } from "../../../config/api-environment";
import {
  loadDeploymentExecution,
  type DeploymentClaim,
} from "../persistence/deployment-store";
import { loadProductionInspectionUpstream } from "./secrets";
import type { ProductionStartInspectionConfiguration } from "./start-inspection";
/** Reads only saved metadata and configured provider authentication. Application database passwords are not loaded. */
export async function productionStartInspectionConfiguration(
  database: typeof db,
  environment: ApiEnvironment,
  claim: DeploymentClaim,
): Promise<ProductionStartInspectionConfiguration> {
  const { deployment, resources } = await loadDeploymentExecution(
    database,
    claim,
  );
  if (
    environment.WRENLY_PRODUCTION_DATABASES_ENABLED !== "true" ||
    !environment.WRENLY_COOLIFY_API_URL ||
    !environment.WRENLY_COOLIFY_API_KEY ||
    !environment.WRENLY_REGISTRY_URL ||
    !environment.WRENLY_PRODUCTION_BROKER_IMAGE_ID ||
    !environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID ||
    !environment.WRENLY_PRODUCTION_INGRESS_IMAGE ||
    resources.coolifyInstanceUrl !==
      new URL(environment.WRENLY_COOLIFY_API_URL).origin ||
    resources.coolifyServerUuid !== environment.WRENLY_COOLIFY_SERVER_UUID ||
    resources.coolifyProjectUuid !== environment.WRENLY_COOLIFY_PROJECT_UUID ||
    resources.coolifyEnvironmentName !==
      environment.WRENLY_COOLIFY_ENVIRONMENT ||
    resources.registryOrigin !==
      new URL(environment.WRENLY_REGISTRY_URL).origin ||
    resources.registryNamespace !== environment.WRENLY_REGISTRY_NAMESPACE ||
    !deployment.artifactImageId ||
    !deployment.registryRepository ||
    !deployment.registryDigest ||
    (deployment.stack !== "nextjs" && deployment.stack !== "laravel")
  )
    throw new Error(
      "Restore the original Production publishing images and placement before inspection.",
    );
  return {
    placement: {
      projectUuid: resources.coolifyProjectUuid,
      serverUuid: resources.coolifyServerUuid,
      environmentName: resources.coolifyEnvironmentName,
    },
    brokerImageId: environment.WRENLY_PRODUCTION_BROKER_IMAGE_ID,
    ingressImageId: environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID,
    images: {
      framework: deployment.stack,
      appImageId: deployment.artifactImageId,
      appImage: `${deployment.registryRepository}@${deployment.registryDigest}`,
      ingressImage: environment.WRENLY_PRODUCTION_INGRESS_IMAGE,
    },
    upstream: await loadProductionInspectionUpstream({ database, claim }),
    client: createDeploymentProviderClient({
      origin: resources.coolifyInstanceUrl,
      token: environment.WRENLY_COOLIFY_API_KEY,
      authentication: "Bearer",
    }),
  };
}
