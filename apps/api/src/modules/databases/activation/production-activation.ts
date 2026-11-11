/** API startup owns the verified Production module and its publishing adapters as one lifecycle. */
import type { db } from "@wrenly/db";
import { verifyProductionInstallationImages } from "@wrenly/sandbox/production-deployment-toolchain";
import type { ApiEnvironment } from "../../../config/api-environment";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { createCoolifyHostVerifier } from "../production-targets/deployment-hosts/coolify-verification";
import {
  startProductionClusterModule,
  type ProductionClusterModule,
} from "../production-targets/module";
import { createProductionDeploymentServices } from "../../deployments/database-runtime/publishing";
import {
  createDeploymentArtifactServices,
  type DeploymentArtifactServices,
} from "../../deployments/execution/deployment-executor";
export interface ProductionDatabaseActivation extends ProductionClusterModule {
  publishing: DeploymentArtifactServices;
}
interface Input {
  database: typeof db;
  environment: ApiEnvironment;
  principal: (headers: Headers) => Promise<AccessPrincipal | null>;
}
interface Adapters {
  verifyImages: typeof verifyProductionInstallationImages;
  start: typeof startProductionClusterModule;
}
/** Disabled installations perform no Production probe, setup or remote operation. */
export async function startProductionDatabaseActivation(
  input: Input,
  adapters: Adapters = {
    verifyImages: verifyProductionInstallationImages,
    start: startProductionClusterModule,
  },
): Promise<ProductionDatabaseActivation | undefined> {
  if (input.environment.WRENLY_PRODUCTION_DATABASES_ENABLED !== "true")
    return undefined;
  const environment = input.environment;
  if (
    environment.WRENLY_APP_DATABASES_ENABLED !== "true" ||
    environment.WRENLY_PUBLISHING_ENABLED !== "true"
  )
    throw new Error(
      "Production databases require database previews and private publishing.",
    );
  const images = {
    brokerImageId: environment.WRENLY_PRODUCTION_BROKER_IMAGE_ID ?? "",
    ingressImageId: environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID ?? "",
    ingressImage: environment.WRENLY_PRODUCTION_INGRESS_IMAGE ?? "",
  };
  const publishing = createDeploymentArtifactServices(
    createProductionDeploymentServices(images),
  );
  if (
    !environment.WRENLY_COOLIFY_API_URL ||
    !environment.WRENLY_COOLIFY_API_KEY ||
    !environment.WRENLY_COOLIFY_SERVER_UUID
  )
    throw new Error(
      "Configure the private publishing destination before enabling Production databases.",
    );
  const verifier = createCoolifyHostVerifier({
    origin: new URL(environment.WRENLY_COOLIFY_API_URL).origin,
    token: environment.WRENLY_COOLIFY_API_KEY,
    serverId: environment.WRENLY_COOLIFY_SERVER_UUID,
  });
  await adapters.verifyImages(images);
  const module = await adapters.start({
    database: input.database,
    directory: environment.WRENLY_DATA_DIR,
    controlDatabaseUrl: environment.WRENLY_DATABASE_URL,
    webUrl: environment.WRENLY_WEB_URL,
    principal: input.principal,
    verifyDeploymentServer: verifier,
  });
  return { ...module, publishing };
}
