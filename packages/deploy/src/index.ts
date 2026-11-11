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

export { resolveDatabaseProvider } from "./databases/provider";
export type { DatabaseProvider, DatabaseProviderIntent, DatabaseProviderResource, DatabaseSetupCredential } from "./databases/provider";
export { createCoolifyDatabaseProvider } from "./providers/coolify/databases/provider";

export { readCoolifyServerIdentity, type CoolifyServerIdentity } from './providers/coolify/server-identity';
export { createDatabaseRuntimeComposition, type DatabaseRuntimeCompositionInput, type DatabaseRuntimeComposition } from './providers/coolify/database-runtime/composition';
