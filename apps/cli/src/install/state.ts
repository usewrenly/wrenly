/** Durable local installation identity contains receipts, never passwords or one-time setup proofs. */
import { z } from "zod";
import { constants } from "node:fs";
import { open, lstat, rename, rm } from "node:fs/promises";
import { join, dirname, parse } from "node:path";
const MAX_PRIVATE_FILE_BYTES = 64 * 1024;
const MAX_CONTROL_SOCKET_PATH_BYTES = 100;
export const InstallationState = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    directory: z.string().startsWith("/"),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    webPort: z.number().int().min(1024).max(65535),
    apiPort: z.number().int().min(1024).max(65535),
    databasePort: z.number().int().min(1024).max(65535),
    previewPort: z.number().int().min(1024).max(65535),
    previews: z.boolean(),
    laravel: z.boolean(),
    phase: z.enum(["prepared", "installing", "ready", "stopped", "attention"]),
    steps: z.record(
      z.string(),
      z.enum(["started", "completed", "unconfirmed"]),
    ),
  })
  .strict();
export type State = z.infer<typeof InstallationState>;
export function statePath(directory: string): string {
  return join(directory, ".wrenly", "install.json");
}
/** Reject symlink ancestors before using an installation path; Unix control sockets also have a short path limit. */
export async function verifyDirectoryPath(directory: string): Promise<void> {
  if (
    !/^\/[A-Za-z0-9_./-]+$/.test(directory) ||
    Buffer.byteLength(join(directory, ".wrenly", "control.sock")) >
      MAX_CONTROL_SOCKET_PATH_BYTES
  )
    throw new Error(
      "Choose a shorter absolute installation path (use simple directory names; control socket limit 100 bytes).",
    );
  let current = directory;
  while (current !== parse(current).root) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(
          "Installation paths must use real directories, not symlinks.",
        );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    current = dirname(current);
  }
}
export async function readPrivate(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_PRIVATE_FILE_BYTES
    )
      throw new Error(
        "Private installation file ownership, permissions or size changed.",
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
export async function writeNewPrivate(
  path: string,
  text: string,
): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readState(directory: string): Promise<State> {
  await verifyDirectoryPath(directory);
  const info = await lstat(join(directory, ".wrenly"));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Installation metadata directory is not private.");
  const result = InstallationState.parse(
    JSON.parse(await readPrivate(statePath(directory))),
  );
  if (result.directory !== directory)
    throw new Error("Installation was moved; inspect it before continuing.");
  return result;
}
export async function saveState(state: State): Promise<void> {
  InstallationState.parse(state);
  const path = statePath(state.directory),
    temporary = path + "." + crypto.randomUUID();
  try {
    await writeNewPrivate(temporary, JSON.stringify(state, null, 2) + "\n");
    await rename(temporary, path);
    const parent = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
