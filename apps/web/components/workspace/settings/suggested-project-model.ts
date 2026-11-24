// Resolves a default saved provider model choice for unconfigured Project Settings Collaboration controls.
import {
  getModelSelection,
  resolveSelection,
  type ModelSelection,
  type ModelsResponse,
} from "@/lib/models/discovery";

const SAVED_CONNECTION_PREFIX = "saved:";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts a saved provider connection UUID from either `saved:<id>:<version>`
 * or a bare connection UUID. Returns null for environment-only providers.
 */
export function extractSavedConnectionId(provider: string): string | null {
  if (provider.startsWith(SAVED_CONNECTION_PREFIX)) {
    const parts = provider.split(":");
    const connectionId = parts[1] ?? "";
    return UUID_REGEX.test(connectionId) ? connectionId : null;
  }
  return UUID_REGEX.test(provider) ? provider : null;
}

/**
 * Returns the serialized `[connectionId, modelId]` option string for the active
 * saved model (browser selection first, then instance default), or `""` if none
 * resolves to a saved connection.
 */
export function resolveSuggestedProjectModel(
  models: ModelsResponse | undefined,
  savedSelection?: ModelSelection | null,
): string {
  if (!models?.models.length) return "";
  let preferred: ModelSelection | null;
  try {
    preferred =
      savedSelection !== undefined
        ? resolveSelection(models, savedSelection)
        : resolveSelection(models, getModelSelection());
  } catch {
    preferred = resolveSelection(models, null);
  }
  if (!preferred) return "";

  const matched = models.models.find(
    (option) =>
      option.provider === preferred.provider && option.id === preferred.model,
  );
  if (!matched) return "";

  const connectionId = extractSavedConnectionId(matched.provider);
  if (!connectionId) return "";
  return JSON.stringify([connectionId, matched.id]);
}
