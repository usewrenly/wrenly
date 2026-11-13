/** Read-only discovery for a lost service-creation acknowledgement. No create/start request belongs here. */
import type { DeploymentProviderClient } from "../../../http/provider-client";
import type { DatabaseRuntimeCompositionInput } from "./composition";
import { verifyDatabaseRuntimeService } from "./service";
const MAX_SERVICES = 1000;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,100}$/;
const record = (raw: unknown): raw is Record<string, unknown> =>
  Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
const databaseId = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0;
export interface DatabaseRuntimePlacement {
  projectUuid: string;
  serverUuid: string;
  environmentName: string;
}
/** A unique name only selects a candidate; pinned placement and exact composition must independently match. Absence is not a creation receipt. */
export async function discoverDatabaseRuntimeService(
  client: DeploymentProviderClient,
  expected: DatabaseRuntimeCompositionInput,
  placement: DatabaseRuntimePlacement,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    if (
      !IDENTIFIER.test(placement.projectUuid) ||
      !IDENTIFIER.test(placement.serverUuid) ||
      !placement.environmentName ||
      placement.environmentName.length > 100 ||
      /[\x00-\x1f]/.test(placement.environmentName)
    )
      throw new Error("Invalid saved placement.");
    signal.throwIfAborted();
    const project = await client.request(
      "GET",
      `/api/v1/projects/${placement.projectUuid}`,
      undefined,
      signal,
    );
    const environment = await client.request(
      "GET",
      `/api/v1/projects/${placement.projectUuid}/${encodeURIComponent(placement.environmentName)}`,
      undefined,
      signal,
    );
    const server = await client.request(
      "GET",
      `/api/v1/servers/${placement.serverUuid}`,
      undefined,
      signal,
    );
    if (
      !record(project) ||
      project.uuid !== placement.projectUuid ||
      !databaseId(project.id) ||
      !record(environment) ||
      !databaseId(environment.id) ||
      environment.project_id !== project.id ||
      environment.name !== placement.environmentName ||
      !record(server) ||
      server.uuid !== placement.serverUuid ||
      !databaseId(server.id)
    )
      throw new Error("Saved service placement could not be verified.");
    // Supported Coolify returns a complete team array; reject pagination/wrappers and ambiguous identities rather than infer absence.
    const services = await client.request(
      "GET",
      "/api/v1/services",
      undefined,
      signal,
    );
    if (
      !Array.isArray(services) ||
      services.length >= MAX_SERVICES ||
      services.some(
        (row) =>
          !record(row) ||
          typeof row.uuid !== "string" ||
          !IDENTIFIER.test(row.uuid) ||
          typeof row.name !== "string",
      ) ||
      new Set(services.map((row) => row.uuid)).size !== services.length
    )
      throw new Error("Complete service collection unavailable.");
    const matches = services.filter(
      (row) => row.name === `wrenly-${expected.deploymentId}`,
    );
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error("Ambiguous service identity.");
    const id: string = matches[0].uuid;
    const service = await client.request(
      "GET",
      `/api/v1/services/${id}`,
      undefined,
      signal,
    );
    if (
      !record(service) ||
      service.uuid !== id ||
      service.server_id !== server.id ||
      service.environment_id !== environment.id ||
      service.deleted_at != null
    )
      throw new Error("Service placement changed.");
    await verifyDatabaseRuntimeService(client, id, expected, signal);
    signal.throwIfAborted();
    return id;
  } catch {
    throw new Error(
      "The original Production service could not be discovered with verified placement and composition. No service was created or started.",
    );
  }
}
