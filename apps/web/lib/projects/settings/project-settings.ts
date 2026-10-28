// Keeps project details tied to the requested project, including conflict recovery.
import { apiFetch } from "../../api";
const SETTINGS_REQUEST_TIMEOUT_MS = 10_000 // Bound reads and saves without claiming a timed-out write failed.

export interface ProjectDetails {
  id: string;
  name: string;
  description: string | null;
  stack: string;
  access: "private";
  createdAt: string;
  updatedAt: string;
}
export interface SettingsChange {
  name: string;
  description: string | null;
  expected: { name: string; description: string | null };
}
export class SettingsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly current?: ProjectDetails,
  ) {
    super(message);
  }
}
/** Rejects incomplete responses instead of showing editable defaults for an unknown project. */
export function parseProjectDetails(value: unknown): ProjectDetails {
  if (!value || typeof value !== "object")
    throw new Error("Project details could not be read.");
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    !(item.description === null || typeof item.description === "string") ||
    typeof item.stack !== "string" ||
    item.access !== "private" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !Number.isFinite(Date.parse(item.updatedAt))
  )
    throw new Error("Project details could not be read.");
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    stack: item.stack,
    access: "private",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
/** Uses bounded, session-authenticated requests; ambiguous failures retain the reviewed snapshot in the screen. */
export async function requestProjectSettings(
  id: string,
  change?: SettingsChange,
  signal?: AbortSignal,
): Promise<ProjectDetails> {
  try {
    const response = await apiFetch(
      `/api/projects/${encodeURIComponent(id)}/settings`,
      {
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS),
        ...(change
          ? {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(change),
            }
          : {}),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "Project details could not be confirmed.";
      const current =
        response.status === 409 &&
        body &&
        typeof body === "object" &&
        "current" in body
          ? matchingProjectDetails(body.current, id)
          : undefined;
      throw new SettingsRequestError(response.status, message, current);
    }
    if (!body || typeof body !== "object" || !("project" in body))
      throw new Error("Project details could not be confirmed.");
    return matchingProjectDetails(body.project, id);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Project details could not be confirmed.");
  }
}

/** A valid response for another project must never become the current editable snapshot. */
function matchingProjectDetails(value: unknown, id: string): ProjectDetails {
  const project = parseProjectDetails(value);
  if (project.id !== id) throw new Error("The returned details do not match this project. Refresh before saving.");
  return project;
}
