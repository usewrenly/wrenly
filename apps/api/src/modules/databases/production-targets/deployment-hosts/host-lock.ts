/** Remote helpers use a distinct lock namespace so a same-host API may retain its publishing lock. */
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const DIRECTORY = join(tmpdir(), "wrenly-runtime-host-locks");
const HANDSHAKE_TIMEOUT_MS = 2000;
export interface RuntimeHostLock {
  assertHeld: () => void;
  release: () => Promise<void>;
}
/** The kernel releases ownership on EOF/crash; lock inodes are intentionally never removed. */
export async function acquireRuntimeHostLock(
  deploymentId: string,
): Promise<RuntimeHostLock> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      deploymentId,
    )
  )
    throw new Error("Invalid runtime host lock identity.");
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = await lstat(DIRECTORY);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error("Runtime host lock storage is unsafe.");
  const path = join(DIRECTORY, `${deploymentId}.lock`);
  try {
    const file = await lstat(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== process.getuid?.()
    )
      throw new Error("Runtime host lock file is unsafe.");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const child = Bun.spawn(
    [
      "flock",
      "--nonblock",
      path,
      "sh",
      "-c",
      "printf 'locked\\n'; cat >/dev/null",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    },
  );
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Runtime host lock timed out."));
        }, HANDSHAKE_TIMEOUT_MS);
      }),
    ]);
    if (first.done || new TextDecoder().decode(first.value) !== "locked\n")
      throw new Error("Another runtime host operation is active.");
  } catch (error) {
    child.stdin.end();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  let released = false;
  return {
    assertHeld: () => {
      if (released || child.exitCode !== null)
        throw new Error("Runtime host lock is no longer held.");
    },
    release: async () => {
      if (released) return;
      released = true;
      child.stdin.end();
      if ((await child.exited) !== 0)
        throw new Error("Runtime host lock release failed.");
    },
  };
}
