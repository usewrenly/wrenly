/** Bounded local inspection with no inherited Docker endpoint or instance credentials. */
import { lstat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:net";
import type { Probes } from "./contracts";
const COMMAND_TIMEOUT_MS = 5000;
const PORT_TIMEOUT_MS = 1000;
const MAX_COMMAND_BYTES = 32 * 1024;
async function command(name: string, args: string[]): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([name, ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/nonexistent",
        DOCKER_CONFIG: "/nonexistent",
        LC_ALL: "C",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    timer = setTimeout(() => child?.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    if (!child.stdout || typeof child.stdout === "number") return null;
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > MAX_COMMAND_BYTES) {
          child.kill("SIGKILL");
          return null;
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    return (await child.exited) === 0
      ? Buffer.concat(chunks).toString("utf8").trim()
      : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
  }
}
async function disk(directory: string): Promise<bigint | null> {
  let current = directory;
  try {
    while (true) {
      try {
        const info = await statfs(current, { bigint: true });
        return info.bavail * info.bsize;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          return null;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  } catch {
    return null;
  }
}
async function destination(
  directory: string,
): ReturnType<Probes["destination"]> {
  try {
    const value = await lstat(directory);
    return value.isSymbolicLink() || !value.isDirectory()
      ? "unsafe"
      : "existing";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "absent"
      : "unconfirmed";
  }
}
async function port(number: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    const server = createServer();
    let done = false;
    const finish = (value: boolean | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close(() => {});
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PORT_TIMEOUT_MS);
    server.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "EADDRINUSE" ? false : null),
    );
    server.listen({ host: "127.0.0.1", port: number, exclusive: true }, () =>
      finish(true),
    );
  });
}
export function createLocalProbes(): Probes {
  return {
    platform: process.platform,
    architecture: process.arch,
    command,
    disk,
    destination,
    port,
  };
}
