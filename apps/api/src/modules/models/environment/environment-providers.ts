/**
 * Explicit environment-provider import metadata.
 * Produces token-free reviewed destination fingerprints; importing copies credentials server-side without editing environment files.
 * Imported IDs must not bypass disabled saved connections through legacy fallback.
 */
import { createHash } from "node:crypto";
import { getProvider, resolveProviders, type ProviderDef } from "./providers";
import { ProviderConnectionError } from "../configuration/provider-connection-store";
export interface EnvironmentProviderMetadata {
  id: string;
  label: string;
  endpoint: string;
  protocol: "ollama" | "openai-compatible";
  kind: "local" | "cloud";
  reviewVersion: string;
}
/** Projects one legacy source without exposing its token or accepting URL credentials. */
export function describeEnvironmentProvider(
  provider: ProviderDef,
): EnvironmentProviderMetadata {
  const protocol = provider.id === "ollama" ? "ollama" : "openai-compatible";
  const url = new URL(
    protocol === "ollama" ? provider.displayUrl : provider.baseUrl,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ProviderConnectionError(
      409,
      "The environment provider address must be credential-free before it can be imported.",
    );
  const endpoint = url.href.replace(/\/+$/, "");
  const kind =
    protocol === "ollama" || url.protocol === "http:" ? "local" : provider.kind;
  const reviewVersion = createHash("sha256")
    .update(JSON.stringify([provider.id, endpoint, protocol, kind]))
    .digest("hex");
  return {
    id: provider.id,
    label: provider.label.slice(0, 100),
    endpoint,
    protocol,
    kind,
    reviewVersion,
  };
}
/** Owner-facing metadata only; malformed legacy configuration never returns its raw URL. */
export function listEnvironmentProviders(): EnvironmentProviderMetadata[] {
  return resolveProviders().flatMap((provider) => {
    try {
      return [describeEnvironmentProvider(provider)];
    } catch {
      return [];
    }
  });
}
/** Reads a token only after the caller has established owner scope; the result stays server-side. */
export function resolveEnvironmentProvider(
  id: string,
): EnvironmentProviderMetadata & { token?: string } {
  try {
    const provider = getProvider(id);
    const metadata = describeEnvironmentProvider(provider);
    return {
      ...metadata,
      ...(id === "ollama" ? {} : { token: provider.apiKey }),
    };
  } catch (error) {
    if (error instanceof ProviderConnectionError) throw error;
    throw new ProviderConnectionError(
      409,
      "This environment provider is no longer configured. Refresh provider settings.",
    );
  }
}
