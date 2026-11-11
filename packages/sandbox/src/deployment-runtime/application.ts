/** Trusted production PID1. Runtime settings arrive on stdin and exist only in the generated child's process environment. */
import { applicationDatabaseEnvironment } from "../databases/application-runtime/environment";
import { LARAVEL_START_COMMAND } from "../source-policy/laravel-runtime";
import { startApplicationHttpBridge } from "./application-http";
const INPUT_BYTES = 8192;
const INPUT_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 500;
const PROBE_INTERVAL_MS = 100;
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** Starts no process when imported; execute only from the repository-owned runtime entrypoint. */
export async function runProductionApplication(): Promise<never> {
  if (process.pid !== 1 || process.getuid?.() !== 0) process.exit(125);
  const controller = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let bridge:
    Awaited<ReturnType<typeof startApplicationHttpBridge>> | undefined;
  const stop = (): void => {
    controller.abort();
    if (child?.exitCode === null) child.kill("SIGTERM");
    shutdownTimer ??= setTimeout(() => {
      if (child?.exitCode === null) child.kill("SIGKILL");
    }, SHUTDOWN_TIMEOUT_MS);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let exitCode: number;
  try {
    inputTimer = setTimeout(() => process.exit(125), INPUT_TIMEOUT_MS);
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > INPUT_BYTES)
          throw new Error("Runtime input exceeds its limit.");
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    clearTimeout(inputTimer);
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !object(input) ||
      Object.keys(input).sort().join(",") !==
        "appKey,framework,resourceId,role,version" ||
      input.version !== 1 ||
      (input.framework !== "nextjs" && input.framework !== "laravel") ||
      typeof input.resourceId !== "string" ||
      !object(input.role) ||
      Object.keys(input.role).sort().join(",") !== "password,user" ||
      typeof input.role.user !== "string" ||
      typeof input.role.password !== "string"
    )
      throw new Error("Invalid runtime input.");
    const settings = applicationDatabaseEnvironment(
      input.framework,
      input.resourceId,
      { user: input.role.user, password: input.role.password },
    );
    if (
      input.framework === "laravel"
        ? typeof input.appKey !== "string" ||
          !/^base64:[A-Za-z0-9+/]{43}=$/.test(input.appKey) ||
          Buffer.from(input.appKey.slice(7), "base64").toString("base64") !==
            input.appKey.slice(7)
        : input.appKey !== null
    )
      throw new Error("Invalid application key.");
    controller.signal.throwIfAborted();
    if (input.framework === "laravel") {
      // Generated paths are handled only as the application user, so symlinks
      // cannot turn trusted startup into a privileged filesystem operation.
      const setup = Bun.spawn(
        [
          "mkdir",
          "-p",
          "/app/bootstrap/cache",
          "/app/storage/framework/sessions",
          "/app/storage/framework/views",
          "/app/storage/framework/cache/data",
          "/app/storage/logs",
        ],
        {
          uid: 1000,
          gid: 1000,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      if ((await setup.exited) !== 0)
        throw new Error("Runtime storage is unavailable.");
    }
    child = Bun.spawn(
      input.framework === "nextjs"
        ? [
            "bun",
            "--no-env-file",
            "node_modules/next/dist/bin/next",
            "start",
            "--hostname",
            "127.0.0.1",
            "--port",
            "3000",
          ]
        : LARAVEL_START_COMMAND,
      {
        cwd: "/app",
        uid: 1000,
        gid: 1000,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp",
          NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
          ...settings,
          ...(input.framework === "laravel"
            ? {
                APP_ENV: "production",
                APP_DEBUG: "false",
                APP_KEY: String(input.appKey),
                SESSION_DRIVER: "file",
                CACHE_STORE: "array",
                LOG_CHANNEL: "stderr",
                XDG_CONFIG_HOME: "/tmp/config",
                XDG_DATA_HOME: "/tmp/data",
              }
            : {}),
        },
      },
    );
    bridge = await startApplicationHttpBridge(controller.signal);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      controller.signal.throwIfAborted();
      try {
        const response = await fetch("http://127.0.0.1:3000/", {
          redirect: "manual",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(PROBE_TIMEOUT_MS),
          ]),
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) {
          ready = true;
          break;
        }
      } catch {
        /* Readiness probing never retries application execution. */
      }
      await Bun.sleep(PROBE_INTERVAL_MS);
    }
    if (!ready) throw new Error("Application readiness was not established.");
    process.stdout.write("WRENLY_PRODUCTION_APPLICATION_READY_V1\n");
    exitCode = await child.exited;
  } catch {
    exitCode = 125;
  } finally {
    clearTimeout(inputTimer);
    stop();
    if (child) await child.exited;
    await bridge?.close();
    clearTimeout(shutdownTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  process.exit(exitCode);
}
