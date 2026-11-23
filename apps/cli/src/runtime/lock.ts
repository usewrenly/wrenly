/** A kernel lock excludes overlapping install/start/stop commands and releases on CLI death. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { cleanEnvironment } from "./process";
const LOCK_REPLY_TIMEOUT_MS = 5000;
export async function acquireInstallationLock(
  directory: string,
  name = "command",
): Promise<() => Promise<void>> {
  const lockPath = join(directory, ".wrenly", `${name}.lock`);
  const file = await open(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Installation lock identity changed.");
  } finally {
    await file.close();
  }
  const child = Bun.spawn(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      lockPath,
      "sh",
      "-c",
      "printf 'locked\\n'; cat >/dev/null",
    ],
    {
      env: cleanEnvironment(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), LOCK_REPLY_TIMEOUT_MS);
  try {
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      if (first.done || new TextDecoder().decode(first.value) !== "locked\n")
        throw new Error(
          "Another installation command is running, or a kernel lock is unavailable.",
        );
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    child.stdin.end();
    await child.exited;
  };
}
