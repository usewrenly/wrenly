/**
 * Environment-configured provider definitions and picker contracts.
 * Maps explicit instance configuration to server-only inference settings; saved dashboard connections are handled separately.
 * API keys stay server-side, while model IDs remain scoped to their provider.
 */

export type ProviderKind = "local" | "cloud";

export interface ProviderDef {
  networkScope?: "local" | "cloud";
  /** Stable id the browser sends back as the model override's provider. */
  id: string;
  /** Human label for the settings page / picker groups. */
  label: string;
  kind: ProviderKind;
  /** OpenAI-compatible base URL the MCP agent should use. */
  baseUrl: string;
  /** API key for the OpenAI SDK (Ollama ignores it but the SDK requires one). */
  apiKey: string;
  /** The URL shown to the user in the UI (settings page, picker groups). */
  displayUrl: string;
}

export interface ModelOption {
  id: string;
  label: string;
  kind: ProviderKind;
  provider: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  kind: ProviderKind;
  displayUrl: string;
  reachable: boolean;
  /** Setup guidance shown when the provider cannot be reached. */
  hint: string | null;
}

export interface ModelsResponse {
  providers: ProviderStatus[];
  models: ModelOption[];
  /** WRENLY_MODEL_NAME — the agent's fallback when no override is sent. */
  envDefault: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
// Probes must never hang the UI — model discovery is best-effort.
const PROBE_TIMEOUT_MS = 2500;

export const DEFAULT_MODEL_NAME = "qwen2.5-coder:14b";

// ─── Provider resolution ───────────────────────────────────────────────────────

function ollamaUrl(): string {
  return (process.env.WRENLY_OLLAMA_URL ?? OLLAMA_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Configured provider";
  }
}

/**
 * All providers this instance can offer, derived from env configuration.
 * Ollama is always offered (it is the P1/self-host default); cloud
 * providers appear only when their credentials exist.
 */
export function resolveProviders(): ProviderDef[] {
  const providers: ProviderDef[] = [
    {
      id: "ollama",
      label: "Ollama (local)",
      kind: "local",
      baseUrl: `${ollamaUrl()}/v1`,
      // Ollama doesn't validate keys; the OpenAI SDK requires a non-empty string.
      apiKey: "ollama",
      displayUrl: ollamaUrl(),
    },
  ];

  // The generic env-configured provider (WRENLY_MODEL_BASE_URL/KEY). Skipped
  // when it points at Ollama — that is already the local provider above.
  const envBase = process.env.WRENLY_MODEL_BASE_URL;
  const envKey = process.env.WRENLY_MODEL_API_KEY;
  if (envBase && envKey && !envBase.startsWith(ollamaUrl())) {
    providers.push({
      id: "env",
      label: urlHost(envBase),
      kind: "cloud",
      baseUrl: envBase,
      apiKey: envKey,
      displayUrl: envBase,
    });
  }

  if (process.env.WRENLY_GROQ_API_KEY) {
    providers.push({
      id: "groq",
      label: "Groq",
      kind: "cloud",
      baseUrl: GROQ_BASE_URL,
      apiKey: process.env.WRENLY_GROQ_API_KEY,
      displayUrl: GROQ_BASE_URL,
    });
  }

  if (process.env.WRENLY_OPENAI_API_KEY) {
    providers.push({
      id: "openai",
      label: "OpenAI",
      kind: "cloud",
      baseUrl: OPENAI_BASE_URL,
      apiKey: process.env.WRENLY_OPENAI_API_KEY,
      displayUrl: OPENAI_BASE_URL,
    });
  }

  return providers;
}

/** Resolves configured inference providers; explicit unknown IDs never fall back. */
export function getProvider(id: string | undefined): ProviderDef {
  const providers = resolveProviders();
  const found = id ? providers.find((p) => p.id === id) : undefined;
  if (found) return found;
  if (id)
    throw new Error(
      "The selected model provider is no longer configured. Select a configured provider and submit a new build.",
    );
  const envProvider = providers.find((p) => p.id === "env");
  if (envProvider) return envProvider;
  // resolveProviders() always includes Ollama — guard anyway for strictness.
  const local = providers.find((p) => p.id === "ollama");
  if (local) return local;
  throw new Error("No model providers configured");
}

// ─── Probing ───────────────────────────────────────────────────────────────────

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Ollama's /api/tags returns { models: [{ name }] }. */
async function probeOllama(provider: ProviderDef): Promise<ModelOption[]> {
  const data = await fetchJson(`${provider.displayUrl}/api/tags`);
  if (!data || typeof data !== "object") return [];
  const models = (data as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (m): m is { name: string } =>
        typeof (m as { name?: unknown })?.name === "string",
    )
    .map((m) => ({
      id: m.name,
      label: m.name,
      kind: "local" as const,
      provider: provider.id,
    }));
}

/** OpenAI-compatible /models returns { data: [{ id }] }. */
async function probeOpenAiCompatible(
  provider: ProviderDef,
): Promise<ModelOption[]> {
  const data = await fetchJson(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });
  if (!data || typeof data !== "object") return [];
  const list = (data as { data?: unknown }).data;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (m): m is { id: string } =>
        typeof (m as { id?: unknown })?.id === "string",
    )
    .map((m) => ({
      id: m.id,
      label: m.id,
      kind: "cloud" as const,
      provider: provider.id,
    }));
}

/**
 * Probes every configured provider in parallel and returns the full
 * discovery payload for GET /api/models. Never throws: an unreachable
 * provider is reported with reachable=false plus a setup hint.
 */
export async function discoverModels(): Promise<ModelsResponse> {
  const providers = resolveProviders();

  const results = await Promise.all(
    providers.map(async (provider) => {
      const models =
        provider.kind === "local"
          ? await probeOllama(provider)
          : await probeOpenAiCompatible(provider);
      return { provider, models };
    }),
  );

  const status: ProviderStatus[] = results.map(({ provider, models }) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    displayUrl: provider.displayUrl,
    reachable: models.length > 0,
    hint:
      models.length > 0
        ? null
        : provider.kind === "local"
          ? "Start Ollama (ollama serve), then pull a model: ollama pull qwen2.5-coder:14b"
          : `No models returned from ${urlHost(provider.baseUrl)} — check the API key in your .env file.`,
  }));

  return {
    providers: status,
    models: results.flatMap((r) => r.models),
    envDefault: process.env.WRENLY_MODEL_NAME ?? DEFAULT_MODEL_NAME,
  };
}
