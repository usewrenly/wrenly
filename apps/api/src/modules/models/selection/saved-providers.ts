/**
 * Durable provider/model selection.
 * Admission freezes the saved connection version and model instead of tokens.
 * Execution resolves only that version; disabled, changed or imported legacy identities fail rather than silently falling back to another endpoint.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  providerConnections,
  instanceModelDefault,
} from "../../../../../../packages/db/src/schema";
import { getProvider, type ProviderDef } from "../environment/providers";
import { resolveSavedProviderConnection } from "../configuration/provider-connection-store";
type Database = Pick<typeof db, "select">;
const Uuid = z.string().uuid();
export interface InferenceSelection {
  provider: string;
  model: string;
}
/** Encodes the immutable connection version into existing durable provider fields. */
export function savedProviderIdentity(id: string, version: string): string {
  return `saved:${Uuid.parse(id)}:${Uuid.parse(version)}`;
}
function parseIdentity(value: string): { id: string; version?: string } | null {
  if (Uuid.safeParse(value).success) return { id: value };
  if (!value.startsWith("saved:")) return null;
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    !Uuid.safeParse(parts[1]).success ||
    !Uuid.safeParse(parts[2]).success
  )
    throw new Error("The saved provider identity is invalid.");
  return { id: parts[1]!, version: parts[2]! };
}
async function savedMetadata(
  database: Database,
  identity: { id: string; version?: string },
): Promise<
  Pick<
    typeof providerConnections.$inferSelect,
    "id" | "version" | "enabled" | "protocol" | "kind"
  >
> {
  const [row] = await database
    .select({
      id: providerConnections.id,
      version: providerConnections.version,
      enabled: providerConnections.enabled,
      protocol: providerConnections.protocol,
      kind: providerConnections.kind,
    })
    .from(providerConnections)
    .where(eq(providerConnections.id, identity.id));
  if (
    !row ||
    !row.enabled ||
    (identity.version && identity.version !== row.version) ||
    !["ollama", "openai-compatible"].includes(row.protocol) ||
    !["local", "cloud"].includes(row.kind)
  )
    throw new Error(
      "The selected provider connection is disabled, unavailable or has a different version.",
    );
  return row;
}
async function rejectImportedLegacyProvider(
  database: Database,
  id: string,
): Promise<void> {
  const [imported] = await database
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(eq(providerConnections.envSourceId, id));
  if (imported)
    throw new Error(
      "This environment provider has moved to a saved connection. Refresh models and choose that connection; no legacy fallback is allowed.",
    );
}
/** Resolves new-admission defaults inside the admission transaction, preserving explicit model choices. */
export async function resolveInferenceSelection(
  database: Database,
  providerId: string | undefined,
  modelId: string | undefined,
): Promise<InferenceSelection> {
  try {
    const [defaults] = await database
      .select()
      .from(instanceModelDefault)
      .where(eq(instanceModelDefault.id, 1));
    let selected = providerId;
    if (!selected && defaults) {
      const row = await savedMetadata(database, { id: defaults.connectionId });
      return {
        provider: savedProviderIdentity(row.id, row.version),
        model: modelId ?? defaults.modelId,
      };
    }
    if (selected) {
      const identity = parseIdentity(selected);
      if (identity) {
        const row = await savedMetadata(database, identity);
        const model =
          modelId ??
          (defaults?.connectionId === row.id ? defaults.modelId : undefined);
        if (!model)
          throw new Error(
            "Choose a model for the selected provider connection.",
          );
        return { provider: savedProviderIdentity(row.id, row.version), model };
      }
    }
    const legacy = getProvider(selected);
    await rejectImportedLegacyProvider(database, legacy.id);
    const model =
      modelId ??
      (!providerId || getProvider(undefined).id === legacy.id
        ? process.env.WRENLY_MODEL_NAME
        : undefined);
    if (!model)
      throw new Error(
        "Choose a model or configure an instance default before sending a message or build.",
      );
    selected = legacy.id;
    return { provider: selected, model };
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Inference settings could not be resolved.",
      { cause: error },
    );
  }
}
/** Server-only execution lookup; default changes cannot alter saved requests and tokens never enter job payloads. */
export async function resolveExecutionProvider(
  database: typeof db,
  identity: string,
  dataDirectory: string,
): Promise<ProviderDef> {
  try {
    if (!identity)
      throw new Error("Execution requires a saved provider identity.");
    const parsed = parseIdentity(identity);
    if (!parsed) {
      const legacy = getProvider(identity);
      await rejectImportedLegacyProvider(database, legacy.id);
      return {
        ...legacy,
        networkScope:
          new URL(legacy.baseUrl).protocol === "http:" ? "local" : legacy.kind,
      };
    }
    if (!parsed.version)
      throw new Error(
        "Queued provider settings must include their immutable version.",
      );
    await savedMetadata(database, parsed);
    const saved = await resolveSavedProviderConnection(
      database,
      parsed.id,
      dataDirectory,
    );
    if (saved.version !== parsed.version)
      throw new Error("The saved provider connection version changed.");
    return {
      id: savedProviderIdentity(saved.id, saved.version),
      label: saved.label,
      kind: saved.kind as "local" | "cloud",
      networkScope: saved.kind as "local" | "cloud",
      baseUrl:
        saved.endpoint.replace(/\/+$/, "") +
        (saved.protocol === "ollama" ? "/v1" : ""),
      apiKey: saved.token ?? "ollama",
      displayUrl: saved.endpoint,
    };
  } catch {
    throw new Error(
      "The selected provider connection is unavailable. Check its enabled state, credentials and encryption key; no fallback provider was used.",
    );
  }
}
