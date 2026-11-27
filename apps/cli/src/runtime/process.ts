/** Fixed trusted commands have deadlines and never print subprocess output or environment values. */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSPECTION_TIMEOUT_MS = 10000;
const MAX_INSPECTION_BYTES = 64 * 1024;
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Builds a minimal environment without inherited secrets or user Docker credentials. */
export function cleanEnvironment(
  dockerConfig = "/nonexistent",
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/nonexistent",
    NEXT_TELEMETRY_DISABLED: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    DOCKER_CONFIG: dockerConfig,
  };
}

function usesDockerBinary(args: string[]): boolean {
  return args.some((arg) => arg === "docker" || arg.endsWith("/docker"));
}

async function withCommandEnvironment<T>(
  args: string[],
  action: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!usesDockerBinary(args)) return action(cleanEnvironment());
  // Docker Buildx creates state inside DOCKER_CONFIG; provide a clean empty
  // directory so host registry credentials stay excluded while builds succeed.
  const dockerDir = await mkdtemp(join(tmpdir(), "wrenly-docker-"));
  await chmod(dockerDir, 0o700);
  try {
    return await action(cleanEnvironment(dockerDir));
  } finally {
    await rm(dockerDir, { recursive: true, force: true });
  }
}

export async function runCommand(
  args: string[],
  cwd: string,
  timeout = COMMAND_TIMEOUT_MS,
  visible = false,
): Promise<void> {
  const { spawn } = await import("node:child_process");
  await withCommandEnvironment(args, async (env) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: [
        "ignore",
        visible ? "inherit" : "ignore",
        visible ? "inherit" : "ignore",
      ],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The owned process group already exited. */
        }
      }
    }, timeout);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", () =>
          reject(new Error("Required local command is unavailable.")),
        );
        child.once("close", (code) =>
          code === 0 && !timedOut
            ? resolve()
            : reject(
                new Error(
                  "Trusted setup command did not complete. Inspect this step before continuing.",
                ),
              ),
        );
      });
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Small read-only command replies are bounded; raw errors and private environment never leave this helper. */
export async function readCommand(
  args: string[],
  cwd: string,
): Promise<string> {
  return withCommandEnvironment(args, async (env) => {
    const child = Bun.spawn(args, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), INSPECTION_TIMEOUT_MS);
    try {
      const reader = child.stdout.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > MAX_INSPECTION_BYTES)
            throw new Error("Inspection reply exceeded bounds.");
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
      if ((await child.exited) !== 0)
        throw new Error("Local service inspection could not be confirmed.");
      return Buffer.concat(chunks).toString("utf8").trim();
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
}
