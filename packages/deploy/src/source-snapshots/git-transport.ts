/**
 * Private source snapshot transport
 * Used by publishing execution; recovery invokes cleanup after subprocesses are known to have settled.
 * Treats files as data, disables Git hooks/global configuration and pushes deterministic commits.
 * Generated code never executes here. Credentials stay out of URLs/arguments/output; provider administration lives elsewhere.
 */
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const MAX_FILES = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const GIT_DEADLINE_MS = 60_000;
const MAX_TOKEN_CHARACTERS = 16_000;
const MAX_CAPTURE_CHARACTERS = 100;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
export class PrivateGitError extends Error {
  constructor() {
    super(
      "Private Git snapshot operation failed. Reconcile the remote commit before retrying.",
    );
    this.name = "PrivateGitError";
  }
}

/** Pushes a deterministic, secret-free snapshot without credentials in URLs/arguments/output. */
export async function pushPrivateSnapshot(
  input: {
    deploymentId?: string;
    files: Array<{ path: string; content: string }>;
    repositoryUrl: string;
    username: string;
    token: string;
  },
  signal: AbortSignal,
): Promise<string> {
  let directory: string | undefined;
  const execution = AbortSignal.any([
    signal,
    AbortSignal.timeout(GIT_DEADLINE_MS),
  ]);
  try {
    if (input.deploymentId && !/^[a-f0-9-]{36}$/.test(input.deploymentId))
      throw new PrivateGitError();
    const url = new URL(input.repositoryUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.git$/.test(url.pathname) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(input.username) ||
      !input.token ||
      input.token.length > MAX_TOKEN_CHARACTERS ||
      /[\r\n]/.test(input.token) ||
      !input.files.length ||
      input.files.length > MAX_FILES ||
      Buffer.byteLength(JSON.stringify(input.files)) > MAX_BYTES
    )
      throw new PrivateGitError();
    const paths = new Set<string>();
    for (const file of input.files) {
      if (
        !file.path ||
        /[\\:\x00-\x1f\x7f]/.test(file.path) ||
        file.path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.toLowerCase() === ".git" ||
              (part.toLowerCase().startsWith(".env") &&
                part !== ".env.example"),
          ) ||
        paths.has(file.path.toLowerCase()) ||
        file.path === ".gitmodules"
      )
        throw new PrivateGitError();
      if (
        file.path.endsWith(".npmrc") &&
        file.content.trim() !== "legacy-peer-deps=true"
      )
        throw new PrivateGitError();
      paths.add(file.path.toLowerCase());
    }
    directory = await mkdtemp(
      join(
        tmpdir(),
        input.deploymentId
          ? `wrenly-private-git-${input.deploymentId}-`
          : "wrenly-private-git-",
      ),
    );
    // A fresh HOME and disabled hooks prevent host or generated Git configuration from executing.
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: `http.${url.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${input.username}:${input.token}`).toString("base64")}`,
      GIT_CONFIG_KEY_1: "http.followRedirects",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const run = (args: string[], capture = false): Promise<string> =>
      new Promise((resolve, reject) => {
        if (execution.aborted) {
          reject(new PrivateGitError());
          return;
        }
        const child = spawn(
          "timeout",
          [
            "--signal=KILL",
            `${GIT_DEADLINE_MS / 1000}s`,
            "git",
            "-C",
            directory!,
            ...args,
          ],
          {
            env: environment,
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          if (capture && output.length < MAX_CAPTURE_CHARACTERS)
            output += chunk.toString();
        });
        const abort = (): void => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const timer = setTimeout(abort, GIT_DEADLINE_MS);
        execution.addEventListener("abort", abort, { once: true });
        child.once("error", () => {
          clearTimeout(timer);
          execution.removeEventListener("abort", abort);
          reject(new PrivateGitError());
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          execution.removeEventListener("abort", abort);
          if (code !== 0 || execution.aborted) reject(new PrivateGitError());
          else resolve(output.trim());
        });
      });
    await run(["init", "--initial-branch=main"]);
    await run(["config", "user.name", "Wrenly Deploy"]);
    await run(["config", "user.email", "deploy@wrenly.local"]);
    for (const file of input.files) {
      execution.throwIfAborted();
      const target = join(directory, file.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    }
    // The snapshot must include generated files even when their own .gitignore excludes them.
    await run(["add", "--force", "--", "."]);
    await run(["commit", "--no-gpg-sign", "-m", "Wrenly source snapshot"]);
    const commit = await run(["rev-parse", "HEAD"], true);
    if (!COMMIT_SHA_PATTERN.test(commit)) throw new PrivateGitError();
    await run(["push", "--force", input.repositoryUrl, "HEAD:refs/heads/main"]);
    return commit;
  } catch {
    throw new PrivateGitError();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Removes this operation's host source copies only after external Git processes have settled. */
export async function cleanupPrivateSnapshotWorkspace(
  deploymentId: string,
): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(deploymentId)) throw new PrivateGitError();
  try {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(`wrenly-private-git-${deploymentId}-`)) continue;
      const path = join(tmpdir(), name);
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.()
      )
        throw new PrivateGitError();
      await rm(path, { recursive: true, force: true });
    }
  } catch {
    throw new PrivateGitError();
  }
}
