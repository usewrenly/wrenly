/**
 * Configured model discovery for the authenticated picker.
 * Checks only saved/environment services under bounded concurrency/deadline, with safe unavailable states.
 * Registry entries are not installed models; discovery never changes defaults or redirects saved credentials.
 */
import { eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  providerConnections,
  instanceModelDefault,
} from "../../../../../../packages/db/src/schema";
import {
  resolveExecutionProvider,
  savedProviderIdentity,
} from "../selection/saved-providers";
import {
  getProvider,
  resolveProviders,
  type ModelOption,
  type ProviderStatus,
  type ModelsResponse,
} from "../environment/providers";
import {
  readProviderModelList,
  parseProviderModels,
} from "../transport/provider-probe";
const PROBE_CONCURRENCY = 3;
const MAX_CONNECTIONS = 20;
const DISCOVERY_TIMEOUT_MS = 8000;
function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "Invalid provider address";
  }
}
/** Discovers only configured services with bounded concurrency; registry entries never count as installed models. */
export async function discoverConfiguredModels(
  database: typeof db,
  dataDirectory: string,
): Promise<ModelsResponse & { defaultProvider: string | null }> {
  try {
    const saved = await database
      .select({
        id: providerConnections.id,
        version: providerConnections.version,
        label: providerConnections.label,
        kind: providerConnections.kind,
        protocol: providerConnections.protocol,
        endpoint: providerConnections.endpoint,
        envSourceId: providerConnections.envSourceId,
        enabled: providerConnections.enabled,
      })
      .from(providerConnections)
      .limit(MAX_CONNECTIONS);
    const suppressed = new Set(
      saved
        .map((row) => row.envSourceId)
        .filter((id): id is string => Boolean(id)),
    );
    const entries = [
      ...saved
        .filter((row) => row.enabled)
        .map((row) => ({
          id: savedProviderIdentity(row.id, row.version),
          label: row.label,
          kind: row.kind as "local" | "cloud",
          protocol: row.protocol,
          displayUrl: safeDisplayUrl(row.endpoint),
        })),
      ...resolveProviders()
        .filter((provider) => !suppressed.has(provider.id))
        .map((provider) => ({
          id: provider.id,
          label: provider.label,
          kind: provider.kind,
          protocol: provider.id === "ollama" ? "ollama" : "openai-compatible",
          displayUrl: safeDisplayUrl(provider.displayUrl),
        })),
    ];
    const [defaults] = await database
      .select()
      .from(instanceModelDefault)
      .where(eq(instanceModelDefault.id, 1));
    const defaultConnection = defaults
      ? saved.find((row) => row.id === defaults.connectionId)
      : undefined;
    const defaultProvider =
      defaults && defaultConnection
        ? savedProviderIdentity(defaultConnection.id, defaultConnection.version)
        : process.env.WRENLY_MODEL_NAME &&
            !suppressed.has(getProvider(undefined).id)
          ? getProvider(undefined).id
          : null;
    const models: ModelOption[] = [],
      providers: ProviderStatus[] = [];
    const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor++]!;
        try {
          deadline.throwIfAborted();
          const provider = await resolveExecutionProvider(
            database,
            entry.id,
            dataDirectory,
          );
          const local = entry.protocol === "ollama";
          const parsed = parseProviderModels(
            await readProviderModelList(
              {
                endpoint: local ? provider.displayUrl : provider.baseUrl,
                kind: provider.networkScope ?? provider.kind,
                protocol: local ? "ollama" : "openai-compatible",
                token: provider.id === "ollama" ? null : provider.apiKey,
              },
              deadline,
            ),
            local ? "ollama" : "openai-compatible",
          );
          providers.push({
            ...entry,
            reachable: true,
            hint:
              parsed.state === "empty"
                ? entry.kind === "local"
                  ? "Connected, but no models are installed. Install a model in this local service, then refresh."
                  : "Connected, but no models were listed. Check model access or choose an explicit catalog model."
                : null,
          });
          models.push(
            ...parsed.models.map((id) => ({
              id,
              label: id,
              kind: entry.kind,
              provider: entry.id,
            })),
          );
        } catch {
          providers.push({
            ...entry,
            reachable: false,
            hint:
              entry.kind === "local"
                ? "The local model service could not be checked. Start it or check its configured server address."
                : "The provider could not be checked. Ask the instance owner to review its connection and token.",
          });
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PROBE_CONCURRENCY, entries.length) },
        worker,
      ),
    );
    // An explicitly configured default can be valid even when /models is unsupported.
    if (
      defaults &&
      defaultConnection?.enabled &&
      !models.some(
        (model) =>
          model.provider === defaultProvider && model.id === defaults.modelId,
      )
    )
      models.push({
        id: defaults.modelId,
        label: `${defaults.modelId} (configured default)`,
        kind: defaultConnection.kind as "local" | "cloud",
        provider: defaultProvider!,
      });
    return {
      providers: providers.sort((a, b) => a.label.localeCompare(b.label)),
      models: models.sort((a, b) => a.label.localeCompare(b.label)),
      envDefault: defaults?.modelId ?? process.env.WRENLY_MODEL_NAME ?? "",
      defaultProvider,
    };
  } catch {
    throw new Error(
      "Configured model discovery is unavailable. Check provider configuration and PostgreSQL.",
    );
  }
}
