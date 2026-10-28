/**
 * Deployment library public contracts
 * Exposes the provider transport abstraction and its structured error type.
 * The API owns authorization, durable publishing, retries and reconciliation.
 * No direct deployment entry point or import-time network operation belongs here.
 */
export {
  createDeploymentProviderClient,
  DeploymentProviderError,
} from "./http/provider-client";
export type { DeploymentProviderClient } from "./http/provider-client";
