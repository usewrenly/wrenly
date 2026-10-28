// Projects safe metadata into browser state; tokens are submitted but never read back.
import { apiFetch } from "../api";
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000 // Bound checks and saves without treating a timeout as proof of rejection.

export interface ProviderConnection {
  id: string;
  version: string;
  label: string;
  protocol: string;
  kind: "local" | "cloud";
  endpoint: string;
  enabled: boolean;
  catalogProviderId: string | null;
  tokenConfigured: boolean;
  envSourceId?: string | null;
}
export interface EnvironmentProvider {
  id: string;
  label: string;
  endpoint: string;
  protocol: string;
  kind: "local" | "cloud";
  reviewVersion: string;
}
export interface ProviderSettings {
  connections: ProviderConnection[];
  environment: EnvironmentProvider[];
  default: { connectionId: string; modelId: string } | null;
}
export interface CatalogEntry {
  id: string;
  name: string;
  endpoint: string | null;
  documentationUrl: string | null;
  compatibility: "openai-compatible" | "adapter-required" | "endpoint-required";
  modelCount: number;
}
export interface CatalogResult {
  version: string;
  fetchedAt: string;
  stale: boolean;
  origin: string;
  totalProviders: number;
  totalModels: number;
  providers: CatalogEntry[];
  models: Array<{ id: string; name: string }>;
}
export interface ConnectionProbe {
  state: "ready" | "empty" | "error";
  models: string[];
  error?: { message: string };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provider settings returned an unreadable response.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Provider metadata is incomplete. Refresh and try again.");
  return value;
}
/** Validates safe connection metadata without accepting credential fields from a response. */
export function parseProviderSettings(value: unknown): ProviderSettings {
  const data = record(value);
  if (!Array.isArray(data.connections))
    throw new Error("Saved connections could not be read.");
  return {
    environment:
      data.environment === undefined
        ? []
        : (() => {
            if (!Array.isArray(data.environment))
              throw new Error(
                "Environment provider metadata could not be read.",
              );
            return data.environment.map((item) => {
              const row = record(item);
              if (!["local", "cloud"].includes(text(row.kind)))
                throw new Error("Environment provider scope is invalid.");
              return {
                id: text(row.id),
                label: text(row.label),
                endpoint: text(row.endpoint),
                protocol: text(row.protocol),
                kind: row.kind as "local" | "cloud",
                reviewVersion: text(row.reviewVersion),
              };
            });
          })(),
    connections: data.connections.map((item) => {
      const row = record(item);
      if (
        !["local", "cloud"].includes(text(row.kind)) ||
        typeof row.enabled !== "boolean" ||
        typeof row.tokenConfigured !== "boolean"
      )
        throw new Error("Saved connection metadata is invalid.");
      return {
        id: text(row.id),
        version: text(row.version),
        label: text(row.label),
        protocol: text(row.protocol),
        kind: row.kind as "local" | "cloud",
        endpoint: text(row.endpoint),
        enabled: row.enabled,
        tokenConfigured: row.tokenConfigured,
        envSourceId: row.envSourceId == null ? null : text(row.envSourceId),
        catalogProviderId:
          row.catalogProviderId === null ? null : text(row.catalogProviderId),
      };
    }),
    default:
      data.default === null
        ? null
        : {
            connectionId: text(record(data.default).connectionId),
            modelId: text(record(data.default).modelId),
          },
  };
}
/** Reads bounded catalog search metadata; executable registry fields are never retained. */
export function parseCatalogResult(value: unknown): CatalogResult {
  const data = record(value);
  if (
    !Array.isArray(data.providers) ||
    !Array.isArray(data.models) ||
    typeof data.totalProviders !== "number" ||
    typeof data.totalModels !== "number" ||
    typeof data.stale !== "boolean"
  )
    throw new Error("The provider catalog could not be read.");
  return {
    version: text(data.version),
    fetchedAt: text(data.fetchedAt),
    stale: data.stale,
    origin: text(data.origin),
    totalProviders: data.totalProviders,
    totalModels: data.totalModels,
    providers: data.providers.map((item) => {
      const row = record(item);
      if (
        ![
          "openai-compatible",
          "adapter-required",
          "endpoint-required",
        ].includes(text(row.compatibility)) ||
        typeof row.modelCount !== "number"
      )
        throw new Error("Provider compatibility is unavailable.");
      return {
        id: text(row.id),
        name: text(row.name),
        endpoint: row.endpoint === null ? null : text(row.endpoint),
        documentationUrl:
          row.documentationUrl === null ? null : text(row.documentationUrl),
        compatibility: row.compatibility as CatalogEntry["compatibility"],
        modelCount: row.modelCount,
      };
    }),
    models: data.models.map((item) => {
      const row = record(item);
      return { id: text(row.id), name: text(row.name) };
    }),
  };
}
/** Separates a healthy empty service from failed model discovery. */
export function parseConnectionProbe(value: unknown): ConnectionProbe {
  const data = record(value);
  if (
    !["ready", "empty", "error"].includes(text(data.state)) ||
    !Array.isArray(data.models) ||
    !data.models.every((item) => typeof item === "string")
  )
    throw new Error("The connection check could not be read.");
  return {
    state: data.state as ConnectionProbe["state"],
    models: data.models,
    ...(data.error
      ? { error: { message: text(record(data.error).message) } }
      : {}),
  };
}
export class ProviderSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderSettingsError";
  }
}
/** Sends configuration only to Wrenly's same-origin API with a bounded wait. */
export async function providerSettingsRequest(
  path: `/api/${string}`,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const response = await apiFetch(path, {
      method,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      ]),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const data = record(value);
      throw new ProviderSettingsError(
        typeof data.error === "string"
          ? data.error
          : "Provider settings could not be updated.",
        response.status,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof ProviderSettingsError) throw error;
    throw new Error(
      "Wrenly could not complete this request. Check the connection and refresh saved providers before retrying.",
      { cause: error },
    );
  }
}
