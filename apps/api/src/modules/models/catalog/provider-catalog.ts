/**
 * Public model metadata validation and normalization.
 * Bounded fixed-registry fetches produce versioned catalog snapshots.
 * Registry package names are display metadata, never executable imports; metadata cannot retarget saved credentials.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
export type CatalogFetcher = (
  url: string,
  options: RequestInit,
) => Promise<Response>;
export const CATALOG_URL = "https://models.dev/api.json";
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDERS = 1024;
const MAX_MODELS = 100_000;
const MAX_MODELS_PER_PROVIDER = 20_000;
const FETCH_TIMEOUT_MS = 10_000;
const Id = z.string().min(1).max(512);
const Label = z.string().min(1).max(512);
const Url = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  });
const DocumentationUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
const RegistryEndpoint = z
  .union([
    Url,
    z
      .string()
      .max(2048)
      .regex(/^\$\{[A-Z][A-Z0-9_]*\}(?:\/[A-Za-z0-9._~-]+)*\/?$/),
  ])
  .transform((value) => (value.startsWith("${") ? undefined : value));
const Money = z.number().nonnegative().finite();
const RawModel = z.object({
  id: Id,
  name: Label,
  canonical_model_id: Id.optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  modalities: z
    .object({
      input: z.array(z.string().max(64)).max(16),
      output: z.array(z.string().max(64)).max(16),
    })
    .optional(),
  limit: z
    .object({
      context: z.number().int().nonnegative().optional(),
      output: z.number().int().nonnegative().optional(),
    })
    .optional(),
  cost: z
    .object({ input: Money.optional(), output: Money.optional() })
    .optional(),
});
const RawProvider = z.object({
  id: Id,
  name: Label,
  npm: z.string().max(256).optional(),
  api: RegistryEndpoint.optional(),
  doc: DocumentationUrl.optional(),
  models: z.record(Id, RawModel),
});
export const CatalogModelSchema = z.object({
  id: Id,
  name: Label,
  canonicalId: Id.optional(),
  toolCalling: z.boolean().nullable(),
  structuredOutput: z.boolean().nullable(),
  reasoning: z.boolean().nullable(),
  inputModalities: z.array(z.string().max(64)).max(16),
  outputModalities: z.array(z.string().max(64)).max(16),
  context: z.number().int().nonnegative().nullable(),
  maxOutput: z.number().int().nonnegative().nullable(),
  inputPricePerMillion: Money.nullable(),
  outputPricePerMillion: Money.nullable(),
});
export const CatalogProviderSchema = z.object({
  id: Id,
  name: Label,
  sdkPackage: z.string().max(256).nullable(),
  endpoint: Url.nullable(),
  documentationUrl: DocumentationUrl.nullable(),
  compatibility: z.enum([
    "openai-compatible",
    "adapter-required",
    "endpoint-required",
  ]),
  models: z.array(CatalogModelSchema).max(MAX_MODELS_PER_PROVIDER),
});
export const CatalogSnapshotSchema = z.object({
  source: z.literal(CATALOG_URL),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  fetchedAt: z.iso.datetime(),
  providers: z.array(CatalogProviderSchema).max(MAX_PROVIDERS),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;
export type CatalogProvider = z.infer<typeof CatalogProviderSchema>;
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}
/** Maps explicit API protocol metadata, never provider names or executable npm imports. */
export function catalogCompatibility(
  sdkPackage: string | undefined,
  endpoint: string | undefined,
): CatalogProvider["compatibility"] {
  if (
    sdkPackage !== "@ai-sdk/openai-compatible" &&
    sdkPackage !== "@ai-sdk/openai"
  )
    return "adapter-required";
  return endpoint ? "openai-compatible" : "endpoint-required";
}
/** Normalizes bounded public metadata without retaining upstream commands, environment names or HTML. */
export function normalizeProviderCatalog(
  raw: unknown,
  now = new Date(),
): CatalogSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CatalogError("The catalog is not a provider map.");
  const entries = Object.entries(raw);
  if (!entries.length || entries.length > MAX_PROVIDERS)
    throw new CatalogError("The catalog provider count is invalid.");
  let modelCount = 0;
  const providers: CatalogProvider[] = entries
    .map(([key, value]) => {
      const parsed = RawProvider.safeParse(value);
      if (!parsed.success || parsed.data.id !== key)
        throw new CatalogError(
          "The catalog contains invalid provider metadata.",
        );
      const provider = parsed.data;
      const models = Object.entries(provider.models);
      modelCount += models.length;
      if (models.length > MAX_MODELS_PER_PROVIDER || modelCount > MAX_MODELS)
        throw new CatalogError("The catalog model count exceeds its limit.");
      return {
        id: provider.id,
        name: provider.name,
        sdkPackage: provider.npm ?? null,
        endpoint: provider.api ?? null,
        documentationUrl: provider.doc ?? null,
        compatibility: catalogCompatibility(provider.npm, provider.api),
        models: models
          .map(([modelKey, model]) => {
            if (modelKey !== model.id)
              throw new CatalogError(
                "The catalog contains inconsistent model identities.",
              );
            return {
              id: model.id,
              name: model.name,
              ...(model.canonical_model_id
                ? { canonicalId: model.canonical_model_id }
                : {}),
              toolCalling: model.tool_call ?? null,
              structuredOutput: model.structured_output ?? null,
              reasoning: model.reasoning ?? null,
              inputModalities: model.modalities?.input ?? [],
              outputModalities: model.modalities?.output ?? [],
              context: model.limit?.context ?? null,
              maxOutput: model.limit?.output ?? null,
              inputPricePerMillion: model.cost?.input ?? null,
              outputPricePerMillion: model.cost?.output ?? null,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const version = createHash("sha256")
    .update(JSON.stringify(providers))
    .digest("hex");
  return {
    source: CATALOG_URL,
    version,
    fetchedAt: now.toISOString(),
    providers,
  };
}
/** Checks cached/bundled normalized metadata, including identity uniqueness and content integrity. */
export function validateCatalogSnapshot(value: unknown): CatalogSnapshot {
  const parsed = CatalogSnapshotSchema.safeParse(value);
  if (!parsed.success || !parsed.data.providers.length)
    throw new CatalogError("The saved catalog is invalid.");
  const snapshot = parsed.data;
  if (
    new Set(snapshot.providers.map((row) => row.id)).size !==
      snapshot.providers.length ||
    snapshot.providers.reduce((total, row) => total + row.models.length, 0) >
      MAX_MODELS ||
    snapshot.providers.some(
      (row) =>
        new Set(row.models.map((model) => model.id)).size !==
          row.models.length ||
        row.compatibility !==
          catalogCompatibility(
            row.sdkPackage ?? undefined,
            row.endpoint ?? undefined,
          ),
    ) ||
    createHash("sha256")
      .update(JSON.stringify(snapshot.providers))
      .digest("hex") !== snapshot.version
  )
    throw new CatalogError("The saved catalog failed its integrity check.");
  return snapshot;
}
/** Fetches the fixed credential-free registry with one deadline and streaming size bound; never follows redirects. */
export async function fetchProviderCatalog(
  fetcher: CatalogFetcher = fetch,
): Promise<CatalogSnapshot> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(CATALOG_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Wrenly-provider-catalog/0.1",
      },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      credentials: "omit",
    });
    if (
      !response.ok ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    )
      throw new CatalogError(
        "The registry did not return a valid catalog response.",
      );
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_CATALOG_BYTES))
      throw new CatalogError("The registry catalog exceeds its size limit.");
    reader = response.body?.getReader();
    if (!reader)
      throw new CatalogError("The registry returned an empty catalog.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_CATALOG_BYTES)
        throw new CatalogError("The registry catalog exceeds its size limit.");
      chunks.push(next.value);
    }
    return normalizeProviderCatalog(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    );
  } catch {
    throw new CatalogError(
      "The provider catalog could not be refreshed. Your saved catalog and connections are unchanged.",
    );
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
