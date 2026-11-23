/** Owns only its API/web children; startup and stop never adopt processes by PID or port. */
import { acquireInstallationLock } from "./lock";
import { createServer } from "node:net";
import { chmod, lstat, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readState, readPrivate, type State } from "../install/state";
import { controlPath, type Reply } from "./control";
import { cleanEnvironment } from "./process";
const CONTROL_INPUT_BYTES = 1024;
const CONTROL_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_POLL_MS = 500;
const START_TIMEOUT_MS = 90000;
const SHUTDOWN_TIMEOUT_MS = 330000;
async function ready(url: string, api: boolean): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    return api
      ? ((await response.json()) as { service?: unknown }).service ===
          "wrenly-api"
      : true;
  } catch {
    return false;
  }
}
/** Controller imports do nothing. Only the detached, identity-bound CLI child calls this entry point. */
export async function serveInstallation(
  directory: string,
  id: string,
): Promise<void> {
  const state = await readState(directory);
  if (state.id !== id) throw new Error("Installation identity changed.");
  await readPrivate(join(directory, ".env"));
  await readPrivate(join(directory, "apps/web/.env.local"));
  const releaseRuntime = await acquireInstallationLock(directory, "runtime");
  const path = controlPath(state);
  try {
    const stale = await lstat(path);
    if (!stale.isSocket() || stale.uid !== process.getuid?.())
      throw new Error("Runtime socket identity changed.");
    await rm(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  let status: Reply["status"] = "starting",
    apiReady = false,
    webReady = false;
  const logs = await open(
    join(directory, ".wrenly", "runtime.log"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  const logInfo = await logs.stat();
  if (
    !logInfo.isFile() ||
    logInfo.uid !== process.getuid?.() ||
    (logInfo.mode & 0o077) !== 0
  ) {
    await logs.close();
    await releaseRuntime();
    throw new Error("Runtime log is not private.");
  }
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      status = "stopping";
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGTERM");
      const finished = Promise.all(children.map((child) => child.exited));
      const timer = setTimeout(() => {
        status = "failed";
      }, SHUTDOWN_TIMEOUT_MS);
      await finished;
      clearTimeout(timer);
      status = "stopped";
      apiReady = false;
      webReady = false;
    })());
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    server.close();
    await rm(path, { force: true });
    await logs.close();
    await releaseRuntime();
  };
  const server = createServer((socket) => {
    let handled = false;
    let input = "";
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > CONTROL_INPUT_BYTES) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n") || handled) return;
      handled = true;
      void (async () => {
        try {
          const request = z
            .object({
              version: z.literal(1),
              id: z.literal(state.id),
              action: z.enum(["status", "stop"]),
            })
            .strict()
            .parse(JSON.parse(input.trim()));
          if (request.action === "stop") {
            socket.setTimeout(0);
            await stop();
          }
          if (request.action === "status" && status === "running") {
            apiReady = await ready(
              `http://127.0.0.1:${state.apiPort}/api/health`,
              true,
            );
            webReady = await ready(
              `http://127.0.0.1:${state.webPort}/sign-in`,
              false,
            );
            if (!apiReady || !webReady) status = "failed";
          }
          socket.end(
            JSON.stringify({
              id: state.id,
              status,
              api: apiReady,
              web: webReady,
            }) + "\n",
          );
          if (request.action === "stop") {
            await cleanup();
          }
        } catch {
          socket.destroy();
        }
      })();
    });
  });
  const onSignal = (): void => {
    void stop()
      .then(cleanup)
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    if (status !== "starting") return;
    const env = cleanEnvironment();
    children.push(
      Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--env-file=${join(directory, ".env")}`,
          "dist/index.js",
        ],
        {
          cwd: join(directory, "apps/api"),
          env,
          stdin: "ignore",
          stdout: logs.fd,
          stderr: logs.fd,
        },
      ),
    );
    children.push(
      Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "node_modules/next/dist/bin/next",
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(state.webPort),
        ],
        {
          cwd: join(directory, "apps/web"),
          env,
          stdin: "ignore",
          stdout: logs.fd,
          stderr: logs.fd,
        },
      ),
    );
    for (const child of children)
      void child.exited.then(() => {
        if (status !== "stopping" && status !== "stopped") {
          status = "failed";
          void stop()
            .then(cleanup)
            .catch(() => {
              process.exitCode = 1;
            });
        }
      });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && status === "starting") {
      apiReady = await ready(
        `http://127.0.0.1:${state.apiPort}/api/health`,
        true,
      );
      webReady = await ready(
        `http://127.0.0.1:${state.webPort}/sign-in`,
        false,
      );
      if (status !== "starting") break;
      if (apiReady && webReady) {
        status = "running";
        break;
      }
      await Bun.sleep(HEALTH_POLL_MS);
    }
    if (status === "starting") {
      status = "failed";
      await stop();
      await cleanup();
    }
  } catch {
    await stop();
    await cleanup();
    throw new Error(
      "Installation runtime could not start. Its configuration and data are preserved.",
    );
  }
}
