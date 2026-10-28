/**
 * Coolify image application adapter
 * Used by the durable publishing executor and reconciliation commands.
 * Configures immutable image digests, triggers explicit jobs and reads exact remote identities.
 * Does not build source, select revisions or retry remote mutations. Runtime secrets are delivered separately.
 */
import type { DeploymentProviderClient } from "../../http/provider-client";
import { PrivateApplicationError } from "./runtime-environment";
// Both verified runtime images expose the same internal port and resource budget.
const APPLICATION_PORT = "3000";
const APPLICATION_CPUS = "2";
const APPLICATION_MEMORY = "2048m";
const MAX_ENVIRONMENT_NAME_CHARACTERS = 100;

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export interface ImageApplication {
  uuid: string;
  image: string;
  url: string | null;
  status: string;
}
function validateReference(value: string): void {
  if (!/^[a-z0-9.:-]+\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/.test(value))
    throw new PrivateApplicationError("invalid_input");
}
/** Keeps creation and repinning under the same runtime restrictions. */
function payload(image: string): Record<string, unknown> {
  validateReference(image);
  return {
    docker_registry_image_name: image,
    docker_registry_image_tag: null,
    ports_exposes: APPLICATION_PORT,
    instant_deploy: false,
    is_auto_deploy_enabled: false,
    is_preview_deployments_enabled: false,
    limits_cpus: APPLICATION_CPUS,
    limits_memory: APPLICATION_MEMORY,
    limits_memory_swap: APPLICATION_MEMORY,
    health_check_enabled: true,
    // BusyBox wget may resolve localhost to ::1 without IPv4 fallback; runtimes bind 0.0.0.0.
    health_check_host: "127.0.0.1",
    health_check_path: "/",
    health_check_method: "GET",
    health_check_port: APPLICATION_PORT,
  };
}

/** Creates an inert Coolify Docker-image app; runtime values are delivered before explicit trigger. */
export async function createImageApplication(
  client: DeploymentProviderClient,
  input: {
    name: string;
    projectUuid: string;
    serverUuid: string;
    environmentName: string;
    image: string;
  },
  signal: AbortSignal,
): Promise<string> {
  if (
    ![input.name, input.projectUuid, input.serverUuid].every(identifier) ||
    !input.environmentName ||
    input.environmentName.length > MAX_ENVIRONMENT_NAME_CHARACTERS
  )
    throw new PrivateApplicationError("invalid_input");
  try {
    const value = await client.request(
      "POST",
      "/api/v1/applications/dockerimage",
      {
        ...payload(input.image),
        name: input.name,
        autogenerate_domain: true,
        project_uuid: input.projectUuid,
        server_uuid: input.serverUuid,
        environment_name: input.environmentName,
      },
      signal,
    );
    if (!record(value) || !identifier(value.uuid))
      throw new PrivateApplicationError("invalid_response");
    return value.uuid;
  } catch (error) {
    throw error;
  }
}

/** Checks the saved remote identity and extracts only non-secret image/runtime metadata. */
export async function readImageApplication(
  client: DeploymentProviderClient,
  uuid: string,
  name: string,
  signal: AbortSignal,
): Promise<ImageApplication> {
  if (!identifier(uuid) || !identifier(name))
    throw new PrivateApplicationError("invalid_input");
  try {
    const value = await client.request(
      "GET",
      `/api/v1/applications/${uuid}`,
      undefined,
      signal,
    );
    if (
      !record(value) ||
      value.uuid !== uuid ||
      value.name !== name ||
      value.build_pack !== "dockerimage" ||
      typeof value.docker_registry_image_name !== "string" ||
      typeof value.docker_registry_image_tag !== "string"
    )
      throw new PrivateApplicationError("invalid_response");
    const repository = value.docker_registry_image_name;
    const tag = value.docker_registry_image_tag;
    const image = repository.endsWith("@sha256")
      ? `${repository}:${tag}`
      : tag.startsWith("sha256-")
        ? `${repository}@sha256:${tag.slice(7)}`
        : `${repository}:${tag}`;
    validateReference(image);
    let url: string | null = null;
    if (typeof value.fqdn === "string" && value.fqdn) {
      const parsed = new URL(value.fqdn.split(",")[0]!.trim());
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new PrivateApplicationError("invalid_response");
      url = parsed.href;
    }
    return {
      uuid,
      image,
      url,
      status: typeof value.status === "string" ? value.status : "unknown",
    };
  } catch (error) {
    throw error;
  }
}

/** Repins an existing image application without triggering a deployment. */
export async function updateImageApplication(
  client: DeploymentProviderClient,
  uuid: string,
  image: string,
  signal: AbortSignal,
): Promise<void> {
  if (!identifier(uuid)) throw new PrivateApplicationError("invalid_input");
  try {
    const configuration = payload(image);
    // Coolify normalizes full digests on POST, but PATCH validates its stored name/tag fields directly.
    const separator = image.lastIndexOf(":");
    await client.request(
      "PATCH",
      `/api/v1/applications/${uuid}`,
      {
        ...configuration,
        docker_registry_image_name: image.slice(0, separator),
        docker_registry_image_tag: image.slice(separator + 1),
      },
      signal,
    );
  } catch (error) {
    throw error;
  }
}

/** Triggers exactly one remote job and validates its relation to the expected app. */
export async function triggerImageDeployment(
  client: DeploymentProviderClient,
  uuid: string,
  signal: AbortSignal,
): Promise<string> {
  if (!identifier(uuid)) throw new PrivateApplicationError("invalid_input");
  try {
    const value = await client.request(
      "POST",
      `/api/v1/deploy?uuid=${uuid}`,
      undefined,
      signal,
    );
    if (
      !record(value) ||
      !Array.isArray(value.deployments) ||
      value.deployments.length !== 1
    )
      throw new PrivateApplicationError("invalid_response");
    const row: unknown = value.deployments[0];
    if (
      !record(row) ||
      row.resource_uuid !== uuid ||
      !identifier(row.deployment_uuid)
    )
      throw new PrivateApplicationError("invalid_response");
    return row.deployment_uuid;
  } catch (error) {
    throw error;
  }
}

/** Reads the exact saved job, never an unrelated latest deployment. */
export async function readImageDeployment(
  client: DeploymentProviderClient,
  uuid: string,
  signal: AbortSignal,
): Promise<"running" | "success" | "failed"> {
  if (!identifier(uuid)) throw new PrivateApplicationError("invalid_input");
  try {
    const row = await client.request(
      "GET",
      `/api/v1/deployments/${uuid}`,
      undefined,
      signal,
    );
    if (
      !record(row) ||
      row.deployment_uuid !== uuid ||
      typeof row.status !== "string"
    )
      throw new PrivateApplicationError("invalid_response");
    if (row.status === "finished") return "success";
    if (
      ["failed", "cancelled", "canceled", "cancelled-by-user"].includes(
        row.status,
      )
    )
      return "failed";
    if (!["queued", "in_progress"].includes(row.status))
      throw new PrivateApplicationError("invalid_response");
    return "running";
  } catch (error) {
    throw error;
  }
}
