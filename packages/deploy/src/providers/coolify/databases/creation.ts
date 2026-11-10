/** Creates provider metadata once; the API must have saved the mutation intent first. */
import type { DeploymentProviderClient } from "../../../http/provider-client";
import { databaseName, databaseMarker, databaseAdministrator, POSTGRES_IMAGE, providerIdentifier, providerRecord, ProductionDatabaseProviderError, type ProductionDatabaseIntent } from "./contract";
const MEMORY_LIMIT = "2048m";
const CPU_LIMIT = "2";
/** Creates a private, stopped PostgreSQL record; this function never retries an uncertain response. */
export async function createPrivateProductionDatabase(client: DeploymentProviderClient, intent: ProductionDatabaseIntent, credential: { user: string; password: string }, signal: AbortSignal): Promise<string> {
  const name = databaseName(intent);
  if (credential.user !== databaseAdministrator(intent) || !/^[a-f0-9]{64}$/.test(credential.password)) throw new ProductionDatabaseProviderError("invalid_input");
  try {
    signal.throwIfAborted();
    const value = await client.request("POST", "/api/v1/databases/postgresql", {
      name, description: databaseMarker(intent),
      project_uuid: intent.projectUuid, server_uuid: intent.serverUuid,
      environment_uuid: intent.environmentUuid, destination_uuid: intent.destinationUuid,
      postgres_user: credential.user, postgres_password: credential.password,
      postgres_db: "app", postgres_host_auth_method: "scram-sha-256",
      image: POSTGRES_IMAGE, is_public: false, instant_deploy: false,
      limits_memory: MEMORY_LIMIT, limits_memory_swap: MEMORY_LIMIT, limits_cpus: CPU_LIMIT,
    }, signal);
    signal.throwIfAborted();
    if (!providerRecord(value) || !providerIdentifier(value.uuid)) throw new ProductionDatabaseProviderError("unconfirmed");
    return value.uuid;
  } catch {
    throw new ProductionDatabaseProviderError("unconfirmed");
  }
}
