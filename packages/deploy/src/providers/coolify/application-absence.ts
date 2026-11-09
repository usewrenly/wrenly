/** Read-only evidence for an explicitly confirmed, settled application-creation recovery. */
import type { DeploymentProviderClient } from "../../http/provider-client";
const MAX_APPLICATIONS = 1000;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
/** Requires access to the pinned project and the complete team collection; errors never prove absence. */
export async function verifyImageApplicationAbsent(
  client: DeploymentProviderClient,
  projectUuid: string,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  if (!identifier(projectUuid) || !identifier(name))
    throw new Error("Invalid application absence selection.");
  signal.throwIfAborted();
  const project = await client.request(
    "GET",
    `/api/v1/projects/${projectUuid}`,
    undefined,
    signal,
  );
  if (!record(project) || project.uuid !== projectUuid)
    throw new Error("Pinned Coolify project could not be verified.");
  // Supported Coolify returns the full current-team collection as an array, without pagination.
  // Reject wrappers, incomplete identities, duplicates and a collection at the limit rather than guessing.
  const applications = await client.request(
    "GET",
    "/api/v1/applications",
    undefined,
    signal,
  );
  if (
    !Array.isArray(applications) ||
    applications.length >= MAX_APPLICATIONS ||
    applications.some(
      (row) =>
        !record(row) ||
        !identifier(row.uuid) ||
        typeof row.name !== "string" ||
        !row.name.trim(),
    ) ||
    new Set(applications.map((row) => row.uuid)).size !== applications.length
  )
    throw new Error(
      "A complete Coolify application collection could not be verified.",
    );
  if (applications.some((row) => row.name === name))
    throw new Error(
      "A matching application exists. Reconcile its exact UUID instead of confirming absence.",
    );
  signal.throwIfAborted();
}
