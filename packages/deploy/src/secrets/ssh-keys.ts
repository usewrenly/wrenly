/**
 * Project SSH key preparation
 * Used by deployment persistence to generate or derive the saved project key identity.
 * Delegates OpenSSH encoding to ssh-keygen with a deadline and private temporary files.
 * No network calls; the caller encrypts the returned private material. Temporary files are removed before returning.
 */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const MAX_PRIVATE_KEY_CHARACTERS = 16_000;
const KEY_OPERATION_TIMEOUT_MS = 3_000;

export interface ProjectSshKey {
  privateKey: string;
  publicKey: string;
}

/** Generates or derives one OpenSSH key pair without network access or credential arguments. */
export async function prepareProjectSshKey(
  privateKey?: string,
): Promise<ProjectSshKey> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "wrenly-ssh-key-"));
    const file = join(directory, "key");
    if (privateKey !== undefined) {
      if (
        privateKey.length > MAX_PRIVATE_KEY_CHARACTERS ||
        !privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")
      )
        throw new Error("Invalid key");
      await writeFile(file, privateKey, { mode: 0o600, flag: "wx" });
    }
    const child = Bun.spawn(
      privateKey === undefined
        ? [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "wrenly-project",
            "-f",
            file,
          ]
        : ["ssh-keygen", "-y", "-f", file],
      {
        env: { PATH: process.env.PATH, HOME: directory },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      KEY_OPERATION_TIMEOUT_MS,
    );
    let output: string;
    try {
      output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) throw new Error("Key operation failed");
    } finally {
      clearTimeout(timer);
    }
    const secret = privateKey ?? (await readFile(file, "utf8"));
    const publicKey =
      privateKey === undefined
        ? (await readFile(file + ".pub", "utf8")).trim()
        : output.trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/.test(publicKey))
      throw new Error("Invalid key");
    return { privateKey: secret, publicKey };
  } catch {
    throw new Error(
      "Project SSH key could not be prepared. Check ssh-keygen and restore any existing encrypted key.",
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
