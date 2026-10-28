/**
 * COMPONENT: Database application startup guardian
 * PURPOSE: Start a database-backed app with process-local credentials and a hard lifetime.
 * INPUTS: Bounded stdin settings; trusted image/source and socket mounts supplied by caller.
 * OUTPUTS: One readiness marker, then exit status; no application logs or credentials.
 * STEPS: Validate input, derive fixed settings, drop the child to UID1000, probe local
 * HTTP, then wait under a trusted deadline. PID1 remains privileged so generated code
 * cannot signal away its guardian. Container exit terminates remaining descendants.
 * EDGE CASES: Stalled stdin, malformed settings, failed startup and premature exit fail.
 * ERROR STATES: Fixed nonzero exits; raw application failures are never forwarded.
 * Separate trusted entrypoints select disposable validation or persistent Development
 * preview input. Validation creates a temporary Laravel key; previews require the
 * caller's stable key. Neither entrypoint accepts Production deployment configuration.
 */
import { randomBytes } from "node:crypto";
import { applicationDatabaseEnvironment } from "./environment";
import { LARAVEL_START_COMMAND } from "../../source-policy/laravel-runtime";

const INPUT_BYTES = 8192;
const INPUT_TIMEOUT_MS = 5000;
const MAX_LIFETIME_MS = 300_000;
const MAX_PREVIEW_LIFETIME_MS = 60 * 60 * 1000; // Runtime expiry still applies if the API disappears.
const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
export const DATABASE_APPLICATION_READY = "WRENLY_DATABASE_APPLICATION_READY_V1";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Execute only as PID1 inside the trusted, offline validation container, never on the API host. */
export function runDatabaseApplicationBootstrap(): Promise<never> {
  return runBootstrap(false);
}

/** Preview callers must deliver their stable Laravel key; validation still uses a disposable key. */
export function runDatabasePreviewBootstrap(): Promise<never> {
  return runBootstrap(true);
}

async function runBootstrap(preview: boolean): Promise<never> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    if (process.pid !== 1 || process.getuid?.() !== 0) process.exit(125);
    // Start before reading stdin: an abandoned or malicious attach cannot keep PID1 alive.
    timer = setTimeout(() => process.exit(137), INPUT_TIMEOUT_MS);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = Bun.stdin.stream().getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > INPUT_BYTES) process.exit(125);
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(value) || Object.keys(value).sort().join(",") !== (preview ? "appKey,framework,lifetimeMs,resourceId,role" : "framework,lifetimeMs,resourceId,role") ||
        (value.framework !== "nextjs" && value.framework !== "laravel") ||
        typeof value.resourceId !== "string" || !object(value.role) ||
        Object.keys(value.role).sort().join(",") !== "password,user" ||
        typeof value.role.user !== "string" || typeof value.role.password !== "string" ||
        typeof value.lifetimeMs !== "number" || !Number.isSafeInteger(value.lifetimeMs) ||
        value.lifetimeMs < 1 || value.lifetimeMs > (preview ? MAX_PREVIEW_LIFETIME_MS : MAX_LIFETIME_MS)) process.exit(125);
    if (preview && (value.framework === "laravel"
      ? typeof value.appKey !== "string" || !/^base64:[A-Za-z0-9+/]{43}=$/.test(value.appKey) ||
        Buffer.from(value.appKey.slice(7), "base64").toString("base64") !== value.appKey.slice(7)
      : value.appKey !== null)) process.exit(125);
    const environment = applicationDatabaseEnvironment(value.framework, value.resourceId, {
      user: value.role.user, password: value.role.password,
    });
    clearTimeout(timer);
    const remainingMs = value.lifetimeMs - (Date.now() - startedAt);
    if (remainingMs <= 0) process.exit(137);
    timer = setTimeout(() => process.exit(137), remainingMs);
    if (value.framework === "laravel") {
      // Empty tmpfs mounts hide directories baked into the image. Create only the
      // fixed writable Laravel layout, as the application user, before booting PHP.
      const setup = Bun.spawn(["mkdir", "-p", "/app/bootstrap/cache", "/app/storage/framework/sessions",
        "/app/storage/framework/views", "/app/storage/framework/cache/data", "/app/storage/logs"], {
        uid: 1000, gid: 1000, stdin: "ignore", stdout: "ignore", stderr: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      });
      if (await setup.exited !== 0) process.exit(125);
    }
    const child = Bun.spawn(value.framework === "nextjs"
      ? ["bun", "--no-env-file", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
      : LARAVEL_START_COMMAND, {
      cwd: "/app", uid: 1000, gid: 1000, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1", ...environment,
        ...(value.framework === "laravel" ? {
          APP_ENV: "production", APP_DEBUG: "false", APP_KEY: preview ? String(value.appKey) : `base64:${randomBytes(32).toString("base64")}`,
          SESSION_DRIVER: "file", CACHE_STORE: "array", LOG_CHANNEL: "stderr",
          XDG_CONFIG_HOME: "/tmp/config", XDG_DATA_HOME: "/tmp/data",
        } : {}),
      },
    });
    let exited = false;
    void child.exited.then(() => { exited = true; });
    while (!exited) {
      try {
        const response = await fetch("http://127.0.0.1:3000/", {
          redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) {
          process.stdout.write(`${DATABASE_APPLICATION_READY}\n`);
          const code = await child.exited;
          clearTimeout(timer);
          // An application exiting cleanly still cannot establish a running preview.
          process.exit(code === 0 ? 125 : code);
        }
      } catch { /* Retry local readiness only; never restart application execution. */ }
      await Bun.sleep(POLL_MS);
    }
    process.exit(125);
  } catch {
    process.exit(125);
  }
}
