/** Provider identities bind remote PostgreSQL records to one saved Wrenly operation. */
export interface ProductionDatabaseIntent {
  resourceId: string;
  operationId: string;
  projectUuid: string;
  serverUuid: string;
  environmentUuid: string;
  destinationUuid: string;
}
export interface ProductionDatabaseIdentity {
  uuid: string;
  name: string;
  status: string;
  sslEnabled: boolean;
}
export class ProductionDatabaseProviderError extends Error {
  constructor(public readonly code: "invalid_input" | "unconfirmed" | "identity_mismatch") {
    super(`Production database provider operation failed (${code}).`);
    this.name = "ProductionDatabaseProviderError";
  }
}
export const POSTGRES_IMAGE = "postgres:17-alpine";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Coolify uses opaque alphanumeric identifiers rather than RFC UUIDs. */
export function providerIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
export function providerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Rejects malformed identities before any authenticated provider call. */
export function validateDatabaseIntent(intent: ProductionDatabaseIntent): void {
  if (
    !UUID.test(intent.resourceId) || !UUID.test(intent.operationId) ||
    ![intent.projectUuid, intent.serverUuid, intent.environmentUuid, intent.destinationUuid].every(providerIdentifier)
  ) throw new ProductionDatabaseProviderError("invalid_input");
}
export function databaseName(intent: ProductionDatabaseIntent): string {
  validateDatabaseIntent(intent);
  return `wrenly-db-${intent.resourceId}`;
}
export function databaseMarker(intent: ProductionDatabaseIntent): string {
  validateDatabaseIntent(intent);
  return `wrenly:production-database:v1:${intent.resourceId}:${intent.operationId}`;
}
export function databaseAdministrator(intent: ProductionDatabaseIntent): string {
  validateDatabaseIntent(intent);
  return `wrenly_${intent.resourceId.replaceAll("-", "")}_admin`;
}
