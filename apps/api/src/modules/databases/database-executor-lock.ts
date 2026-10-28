// A resource kernel lock prevents overlap with an old executor and ends with its owning API process.
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseClaim } from "./database-store";
const DIRECTORY = join(tmpdir(), "wrenly-database-locks");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HANDSHAKE_MS = 2000;
export interface DatabaseExecutorLock {
  assertHeld: () => void;
  release: () => Promise<void>;
}
/** Locks the resource, not the attempt, so recovery cannot overlap an earlier executor. */
export async function acquireDatabaseExecutorLock(
  claim: DatabaseClaim,
): Promise<DatabaseExecutorLock> {
  if (![claim.id, claim.resourceId, claim.token].every((id) => UUID.test(id)))
    throw new Error("Invalid database execution identity.");
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = await lstat(DIRECTORY);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error("Database lock directory must be private.");
  const path = join(DIRECTORY, `${claim.resourceId}.lock`);
  try {
    const file = await lstat(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== process.getuid?.()
    )
      throw new Error("Unsafe database lock file.");
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
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
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Database lock handshake timed out."));
        }, HANDSHAKE_MS);
      }),
    ]);
    if (first.done || new TextDecoder().decode(first.value) !== "locked\n")
      throw new Error("Previous database executor is still active.");
  } catch (error) {
    child.stdin.end();
    await child.exited;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  let released = false;
  return {
    assertHeld: () => {
      if (released || child.exitCode !== null)
        throw new Error("Database executor lock is no longer held.");
    },
    release: async () => {
      if (released) return;
      released = true;
      child.stdin.end();
      if ((await child.exited) !== 0)
        throw new Error("Database executor lock did not release cleanly.");
    },
  };
}
