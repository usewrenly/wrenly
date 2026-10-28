/**
 * Runtime environment policy
 * Used by deployment persistence before settings are encrypted or delivered to a provider.
 * Bounds user settings, reserves deployment control variables and enforces Laravel production policy.
 * This is provider-independent validation; Coolify delivery is a separate adapter.
 */
const MAX_VARIABLES = 100;
const MAX_VALUE_BYTES = 8192;
const MAX_ENVIRONMENT_BYTES = 64 * 1024;
const CONTROL_NAMES = new Set([
  "APP_KEY",
  "PATH",
  "HOME",
  "PORT",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);
const CONTROL_PREFIX = /^(?:WRENLY_|COOLIFY_|NIXPACKS_|DOCKER_|GIT_|SSH_)/;
export class RuntimeEnvironmentError extends Error {
  constructor() {
    super(
      "Saved runtime environment is invalid or contains reserved deployment variables.",
    );
    this.name = "RuntimeEnvironmentError";
  }
}

/** Validates operator settings without including secret names or values in failures. */
export function validateRuntimeEnvironment(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeEnvironmentError();
  const entries = Object.entries(value);
  if (entries.length > MAX_VARIABLES) throw new RuntimeEnvironmentError();
  let bytes = 0;
  for (const [name, setting] of entries) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
      CONTROL_NAMES.has(name) ||
      CONTROL_PREFIX.test(name) ||
      typeof setting !== "string" ||
      setting.includes("\0") ||
      Buffer.byteLength(setting) > MAX_VALUE_BYTES
    )
      throw new RuntimeEnvironmentError();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(setting);
    if (bytes > MAX_ENVIRONMENT_BYTES) throw new RuntimeEnvironmentError();
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Combines operator settings with a stable application key and enforced production/debug policy. */
export function laravelRuntimeEnvironment(
  settings: Record<string, string>,
  appKey: string,
): Record<string, string> {
  const validated = validateRuntimeEnvironment(settings);
  if (!/^base64:[A-Za-z0-9+/]{43}=$/.test(appKey))
    throw new RuntimeEnvironmentError();
  return {
    LOG_CHANNEL: "stderr",
    SESSION_DRIVER: "file",
    CACHE_STORE: "array",
    QUEUE_CONNECTION: "sync",
    ...validated,
    APP_ENV: "production",
    APP_DEBUG: "false",
    APP_KEY: appKey,
  };
}
