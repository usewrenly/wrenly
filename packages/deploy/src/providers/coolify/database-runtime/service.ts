/** Coolify service adapter for the fixed isolated topology. Durable callers own mutation intent and unknown-result recovery. */
import type { DeploymentProviderClient } from "../../../http/provider-client";
import {
  createDatabaseRuntimeComposition,
  type DatabaseRuntimeCompositionInput,
} from "./composition";
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,100}$/;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** Creates an inert service. Creation never delivers runtime credentials or starts an application. */
export async function createDatabaseRuntimeService(
  client: DeploymentProviderClient,
  input: DatabaseRuntimeCompositionInput & {
    projectUuid: string;
    serverUuid: string;
    environmentName: string;
  },
  signal: AbortSignal,
): Promise<string> {
  try {
    if (
      ![input.projectUuid, input.serverUuid].every((value) =>
        IDENTIFIER.test(value),
      ) ||
      !input.environmentName ||
      input.environmentName.length > 100 ||
      /[\x00-\x1f]/.test(input.environmentName)
    )
      throw new Error("Invalid placement.");
    const composition = createDatabaseRuntimeComposition(input);
    const response = await client.request(
      "POST",
      "/api/v1/services",
      {
        name: `wrenly-${input.deploymentId}`,
        project_uuid: input.projectUuid,
        server_uuid: input.serverUuid,
        environment_name: input.environmentName,
        docker_compose_raw: Buffer.from(composition.document).toString(
          "base64",
        ),
        instant_deploy: false,
        connect_to_docker_network: false,
        force_domain_override: false,
        redact_all_env_values_in_logs: true,
      },
      signal,
    );
    if (
      !record(response) ||
      typeof response.uuid !== "string" ||
      !IDENTIFIER.test(response.uuid)
    )
      throw new Error("Invalid receipt.");
    signal.throwIfAborted();
    return response.uuid;
  } catch {
    throw new Error(
      "Database publishing service creation could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}
/** Accepts only the selected service with its original fixed composition; never adopts a similarly named service. */
export async function verifyDatabaseRuntimeService(
  client: DeploymentProviderClient,
  serviceId: string,
  expected: DatabaseRuntimeCompositionInput,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!IDENTIFIER.test(serviceId)) throw new Error("Invalid service.");
    const response = await client.request(
      "GET",
      `/api/v1/services/${serviceId}`,
      undefined,
      signal,
    );
    const composition = createDatabaseRuntimeComposition(expected);
    if (
      !record(response) ||
      response.uuid !== serviceId ||
      response.name !== `wrenly-${expected.deploymentId}` ||
      response.docker_compose_raw !== composition.document ||
      response.connect_to_docker_network !== false
    )
      throw new Error("Service identity changed.");
    signal.throwIfAborted();
  } catch {
    throw new Error(
      "The saved database publishing service could not be verified.",
    );
  }
}
/** A queue acknowledgement is not readiness; caller must inspect actual host containers and the served revision afterward. */
export async function startDatabaseRuntimeService(
  client: DeploymentProviderClient,
  serviceId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!IDENTIFIER.test(serviceId)) throw new Error("Invalid service.");
    const response = await client.request(
      "POST",
      `/api/v1/services/${serviceId}/start`,
      undefined,
      signal,
    );
    if (
      !record(response) ||
      response.message !== "Service starting request queued."
    )
      throw new Error("Invalid start receipt.");
    signal.throwIfAborted();
  } catch {
    throw new Error(
      "Database publishing service start could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}

/** Reads only the relay's single configured route; the generated application must never have a direct public domain. */
export async function readDatabaseRuntimeServiceRoute(
  client: DeploymentProviderClient,
  serviceId: string,
  expected: DatabaseRuntimeCompositionInput,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    await verifyDatabaseRuntimeService(client, serviceId, expected, signal);
    const response = await client.request(
      "GET",
      `/api/v1/services/${serviceId}`,
      undefined,
      signal,
    );
    if (
      !record(response) ||
      response.uuid !== serviceId ||
      response.name !== `wrenly-${expected.deploymentId}` ||
      response.docker_compose_raw !==
        createDatabaseRuntimeComposition(expected).document ||
      response.connect_to_docker_network !== false ||
      !Array.isArray(response.applications) ||
      response.applications.length !== 2
    )
      throw new Error("Unexpected service applications.");
    const apps = response.applications;
    if (!apps.every(record)) throw new Error("Invalid service applications.");
    const application = apps.filter((app) => app.name === "application"),
      ingress = apps.filter((app) => app.name === "ingress");
    if (
      application.length !== 1 ||
      ingress.length !== 1 ||
      (application[0]!.fqdn !== null && application[0]!.fqdn !== "")
    )
      throw new Error("Direct application exposure changed.");
    const route = ingress[0]!.fqdn;
    if (route === null || route === "") return null;
    if (typeof route !== "string" || route.length > 2048 || route.includes(","))
      throw new Error("Ambiguous relay route.");
    const url = new URL(route);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Invalid relay route.");
    signal.throwIfAborted();
    return url.href;
  } catch {
    throw new Error("The saved Production HTTP route could not be verified.");
  }
}
