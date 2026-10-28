/**
 * MCP inference environment allowlist.
 * Passes only the selected inference endpoint, token, model and applicable limits to the framework subprocess.
 * Never forwards the general API environment or unrelated instance secrets.
 */

import { DEFAULT_MODEL_NAME, type ProviderDef } from "./providers";

/** Restricts subprocess configuration to the inference credentials it needs. */
export function buildModelEnvironment(
  model: string | undefined,
  provider: Pick<ProviderDef, "baseUrl" | "apiKey" | "networkScope">,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return {
    WRENLY_MODEL_NAME:
      model ?? environment.WRENLY_MODEL_NAME ?? DEFAULT_MODEL_NAME,
    WRENLY_MODEL_BASE_URL: provider.baseUrl,
    WRENLY_MODEL_API_KEY: provider.apiKey,
    ...(environment.WRENLY_MODEL_TIMEOUT_SECONDS
      ? {
          WRENLY_MODEL_TIMEOUT_SECONDS:
            environment.WRENLY_MODEL_TIMEOUT_SECONDS,
        }
      : {}),
    ...(provider.networkScope
      ? { WRENLY_MODEL_NETWORK_SCOPE: provider.networkScope }
      : {}),
  };
}
