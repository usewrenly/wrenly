/** Explicit installation steps use only the verified source and this installation's resources. */
import { join } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  PINNED_RELEASE,
  downloadRelease,
  MAX_ARCHIVE_BYTES,
} from "../install/release";
import { prepareInstallation, type Settings } from "../install/prepare";
import {
  readState,
  saveState,
  readPrivate,
  writeNewPrivate,
  type State,
} from "../install/state";
import { acquireInstallationLock } from "../runtime/lock";
import { startDatabase, inspectDatabase } from "../runtime/compose";
import { runCommand } from "../runtime/process";
import { startRuntime, verifyConfiguration } from "./management";
export interface InstallOptions extends Settings {
  archive?: string;
}
async function archiveBytes(path: string | undefined): Promise<Uint8Array> {
  if (!path) return downloadRelease(PINNED_RELEASE);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES)
      throw new Error(
        "Choose a regular source archive within the 128 MiB bound.",
      );
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function step(
  state: State,
  name: string,
  action: () => Promise<void>,
  write: (text: string) => void,
): Promise<void> {
  if (state.steps[name] === "completed") return;
  state.steps[name] = "started";
  state.phase = "installing";
  await saveState(state);
  write(`Preparing ${name}…\n`);
  try {
    await action();
    state.steps[name] = "completed";
    await saveState(state);
    write(`${name} ready.\n`);
  } catch {
    state.steps[name] = "unconfirmed";
    state.phase = "attention";
    await saveState(state);
    throw new Error(
      `${name} did not complete. Configuration and data are preserved. Inspect status, then explicitly resume when the previous command has settled.`,
    );
  }
}
/** A separate kernel step lock remains held if the interactive CLI dies while a build/migration continues. */
async function trustedStep(
  state: State,
  args: string[],
  cwd: string,
  timeout?: number,
): Promise<void> {
  await runCommand(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      "--no-fork",
      join(state.directory, ".wrenly", "step.lock"),
      ...args,
    ],
    cwd,
    timeout,
  );
}
export async function installNew(
  options: InstallOptions,
  entryPath: string,
  write: (text: string) => void,
): Promise<State> {
  write(
    `Downloading verified Wrenly source ${PINNED_RELEASE.revision.slice(0, 8)}…\n`,
  );
  const state = await prepareInstallation(
    options,
    PINNED_RELEASE,
    await archiveBytes(options.archive),
  );
  // Preserve an independently bundled operator entry point, so a later npm update cannot change this instance's supervisor.
  const bundle = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    env: "disable",
  });
  if (!bundle.success || !bundle.outputs[0])
    throw new Error("Could not prepare the installation's operator bundle.");
  await writeNewPrivate(
    join(state.directory, ".wrenly", "operator.js"),
    await bundle.outputs[0].text(),
  );
  return resumeInstallation(state.directory, write);
}
export async function resumeInstallation(
  directory: string,
  write: (text: string) => void,
): Promise<State> {
  const state = await readState(directory);
  if (
    state.revision !== PINNED_RELEASE.revision ||
    state.sha256 !== PINNED_RELEASE.sha256
  )
    throw new Error(
      "This CLI does not manage that source release. Use its matching operator version.",
    );
  const release = await acquireInstallationLock(directory);
  try {
    await verifyConfiguration(state);
    if (state.phase === "ready" || state.phase === "stopped")
      throw new Error(
        "Installation is already prepared. Use start or status; resume does not rebuild a running instance.",
      );
    await step(
      state,
      "dependencies",
      () =>
        trustedStep(
          state,
          [
            process.execPath,
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
          ],
          directory,
        ),
      write,
    );
    await step(
      state,
      "API build",
      () =>
        trustedStep(
          state,
          [process.execPath, "--no-env-file", "run", "build"],
          join(directory, "apps/api"),
        ),
      write,
    );
    await step(
      state,
      "web build",
      () =>
        trustedStep(
          state,
          [process.execPath, "--no-env-file", "run", "build"],
          join(directory, "apps/web"),
        ),
      write,
    );
    if (state.laravel)
      await step(
        state,
        "Laravel toolchain",
        () =>
          trustedStep(
            state,
            [
              "docker",
              "--host",
              "unix:///var/run/docker.sock",
              "build",
              "-t",
              "wrenly/laravel-runtime:13-php8.4",
              "packages/sandbox/images/laravel",
            ],
            directory,
            20 * 60 * 1000,
          ),
        write,
      );
    if (state.previews)
      await step(
        state,
        "preview image",
        () =>
          trustedStep(
            state,
            [
              "docker",
              "--host",
              "unix:///var/run/docker.sock",
              "pull",
              "oven/bun:alpine",
            ],
            directory,
          ),
        write,
      );
    await step(state, "database", () => startDatabase(state), write);
    if ((await inspectDatabase(state)) !== "running")
      await startDatabase(state);
    // The native migrator inspects its transactional journal and never reapplies committed control migrations.
    // Explicit resume still takes the step lock, so it cannot overlap an older surviving migration process.
    await step(
      state,
      "schema",
      async () => {
        if ((await inspectDatabase(state)) !== "running")
          throw new Error("Installation database is not running.");
        await trustedStep(
          state,
          [
            process.execPath,
            "--no-env-file",
            `--env-file=${join(directory, ".env")}`,
            "run",
            "db:migrate",
          ],
          join(directory, "packages/db"),
        );
      },
      write,
    );
    await step(state, "runtime", () => startRuntime(state), write);
    await startRuntime(state);
    state.phase = "ready";
    await saveState(state);
    return state;
  } finally {
    await release();
  }
}
