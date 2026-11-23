/** Read-only identity recovery; a running container is not evidence of verified TLS or database readiness. */
import type { DeploymentProviderClient } from "../../../http/provider-client";
import { databaseName, databaseMarker, databaseAdministrator, POSTGRES_IMAGE, providerIdentifier, providerRecord, ProductionDatabaseProviderError, type ProductionDatabaseIntent, type ProductionDatabaseIdentity } from "./contract";
const MAX_DATABASES = 256;
const MAX_DATABASE_NAME_CHARACTERS = 255;
const MAX_DATABASE_STATUS_CHARACTERS = 100;
function identity(value: unknown, uuid: string, intent: ProductionDatabaseIntent): ProductionDatabaseIdentity {
  if (
    !providerRecord(value) ||
    value.uuid !== uuid ||
    value.name !== databaseName(intent) ||
    value.description !== databaseMarker(intent) ||
    value.database_type !== "standalone-postgresql" ||
    value.image !== POSTGRES_IMAGE ||
    value.postgres_user !== databaseAdministrator(intent) ||
    value.postgres_db !== "app" ||
    value.is_public !== false ||
    (value.public_port !== null && value.public_port !== undefined) ||
    (value.ports_mappings !== null && value.ports_mappings !== undefined && value.ports_mappings !== "") ||
    typeof value.status !== "string" ||
    value.status.length > MAX_DATABASE_STATUS_CHARACTERS ||
    typeof value.enable_ssl !== "boolean"
  ) throw new ProductionDatabaseProviderError("identity_mismatch");
  // A matching label alone cannot authorize a resource moved to another destination.
  if (
    !providerRecord(value.destination) ||
    value.destination.uuid !== intent.destinationUuid ||
    !providerRecord(value.destination.server) ||
    value.destination.server.uuid !== intent.serverUuid
  ) throw new ProductionDatabaseProviderError("identity_mismatch");
  return { uuid, name: databaseName(intent), status: value.status, sslEnabled: value.enable_ssl };
}
/** Returns only allowlisted facts after comparing the saved UUID and operation marker. */
export async function readPrivateProductionDatabase(client: DeploymentProviderClient, uuid: string, intent: ProductionDatabaseIntent, signal: AbortSignal): Promise<ProductionDatabaseIdentity> {
  databaseName(intent);
  if (!providerIdentifier(uuid)) throw new ProductionDatabaseProviderError("invalid_input");
  try {
    signal.throwIfAborted();
    const value = await client.request("GET", `/api/v1/databases/${uuid}`, undefined, signal);
    signal.throwIfAborted();
    return identity(value, uuid, intent);
  } catch (error) {
    if (error instanceof ProductionDatabaseProviderError) throw error;
    throw new ProductionDatabaseProviderError("unconfirmed");
  }
}
/** Absence never triggers creation. Callers must separately confirm recovery of the saved intent. */
export async function findPrivateProductionDatabase(client: DeploymentProviderClient, intent: ProductionDatabaseIntent, signal: AbortSignal): Promise<ProductionDatabaseIdentity | null> {
  const name = databaseName(intent), marker = databaseMarker(intent);
  try {
    signal.throwIfAborted();
    const project = await client.request("GET", `/api/v1/projects/${intent.projectUuid}`, undefined, signal);
    if (!providerRecord(project) || project.uuid !== intent.projectUuid) throw new ProductionDatabaseProviderError("unconfirmed");
    const rows = await client.request("GET", "/api/v1/databases", undefined, signal);
    signal.throwIfAborted();
    if (!Array.isArray(rows) || rows.length >= MAX_DATABASES) throw new ProductionDatabaseProviderError("unconfirmed");
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (
        !providerRecord(row) || !providerIdentifier(row.uuid) ||
        typeof row.name !== "string" || !row.name.trim() ||
        row.name.length > MAX_DATABASE_NAME_CHARACTERS || seen.has(row.uuid)
      ) throw new ProductionDatabaseProviderError("unconfirmed");
      seen.add(row.uuid);
      if (row.name === name || row.description === marker) {
        if (row.name !== name || row.description !== marker) throw new ProductionDatabaseProviderError("identity_mismatch");
        candidates.push(row.uuid);
      }
    }
    if (candidates.length > 1) throw new ProductionDatabaseProviderError("identity_mismatch");
    return candidates[0] ? await readPrivateProductionDatabase(client, candidates[0], intent, signal) : null;
  } catch (error) {
    if (error instanceof ProductionDatabaseProviderError) throw error;
    throw new ProductionDatabaseProviderError("unconfirmed");
  }
}
