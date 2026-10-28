/**
 * Coolify runtime environment delivery
 * Used by the publishing executor after application configuration and before deployment.
 * Sends literal runtime-only values and verifies the provider acknowledges their policy flags.
 * Never returns secret values, enables build-time injection or retries uncertain writes.
 */
import type { DeploymentProviderClient } from "../../http/provider-client";

// Delivery includes framework-owned settings in addition to the 100 user variables.
const MAX_DELIVERY_VARIABLES = 110;
const MAX_VALUE_BYTES = 8_192;

export class PrivateApplicationError extends Error {
  constructor(public readonly code: "invalid_input" | "invalid_response") {
    super(`Private deployment application validation failed (${code}).`);
    this.name = "PrivateApplicationError";
  }
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
/** Delivers values exclusively as literal runtime variables, never build arguments or source. */
export async function deliverRuntimeEnvironment(
  client: DeploymentProviderClient,
  applicationUuid: string,
  environment: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  if (
    !identifier(applicationUuid) ||
    Object.keys(environment).length > MAX_DELIVERY_VARIABLES
  )
    throw new PrivateApplicationError("invalid_input");
  const data = Object.entries(environment).map(([key, value]) => {
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Buffer.byteLength(value) > MAX_VALUE_BYTES
    )
      throw new PrivateApplicationError("invalid_input");
    return {
      key,
      value,
      is_preview: false,
      is_literal: true,
      is_multiline: value.includes("\n"),
      is_shown_once: true,
      is_runtime: true,
      is_buildtime: false,
    };
  });
  if (!data.length) return;
  try {
    const result = await client.request(
      "PATCH",
      `/api/v1/applications/${applicationUuid}/envs/bulk`,
      { data },
      signal,
    );
    if (
      !Array.isArray(result) ||
      result.length !== data.length ||
      data.some(
        (expected) =>
          !result.some(
            (value) =>
              value &&
              typeof value === "object" &&
              value.key === expected.key &&
              value.is_runtime === true &&
              value.is_buildtime === false &&
              value.is_preview === false &&
              value.is_literal === true,
          ),
      )
    )
      throw new PrivateApplicationError("invalid_response");
  } catch (error) {
    throw error;
  }
}
