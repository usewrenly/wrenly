/** Manage the exact local installation through its private control socket, never by guessed process IDs. */
import { z } from "zod";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  readState,
  readPrivate,
  saveState,
  type State,
} from "../install/state";
import { SPEECH_MODEL_FILENAME } from "../install/speech-model";
import { runtimeRequest, type Reply } from "../runtime/control";
import { cleanEnvironment } from "../runtime/process";
import { renderOwnerSetupLink } from "../presentation";
import {
  inspectDatabase,
  startDatabase,
  stopDatabase,
} from "../runtime/compose";
import { acquireInstallationLock } from "../runtime/lock";
const RUNTIME_START_TIMEOUT_MS = 100000;
const RUNTIME_POLL_MS = 500;
const OWNER_SETUP_TIMEOUT_MS = 30000;
const MAX_SETUP_OUTPUT_BYTES = 8 * 1024;

export interface BrowserHandoff {
  desktop?: boolean;
  open?: (url: string) => Promise<boolean>;
  write(text: string): void;
}
function environment(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || result.has(key))
      throw new Error("Configuration contains duplicate or malformed entries.");
    result.set(key, line.slice(separator + 1));
  }
  return result;
}
/** Preserve secrets, but refuse database retargeting before any installer migration or service action. */
export async function verifyConfiguration(state: State): Promise<void> {
  const values = environment(await readPrivate(join(state.directory, ".env")));
  const password = values.get("WRENLY_INSTALL_DATABASE_PASSWORD");
  const secrets = z
    .object({
      WRENLY_INSTALL_DATABASE_PASSWORD: z.string().regex(/^[a-f0-9]{64}$/),
      WRENLY_DATABASE_URL: z.url(),
      WRENLY_AUTH_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
      WRENLY_DEPLOY_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(Object.fromEntries(values));
  if (
    !secrets.success ||
    values.get("WRENLY_DATABASE_URL") !==
      `postgresql://wrenly:${password}@127.0.0.1:${state.databasePort}/wrenly`
  )
    throw new Error(
      "Installation keys or database configuration changed. Restore the original private configuration; no new keys were generated.",
    );
  for (const [name, value] of Object.entries({
    WRENLY_DATA_DIR: join(state.directory, ".wrenly", "data"),
    WRENLY_PREVIEW_BASE_URL: `http://wrenly-preview.localhost:${state.previewPort}`,
    WRENLY_API_HOST: "127.0.0.1",
    WRENLY_API_PORT: String(state.apiPort),
    WRENLY_WEB_URL: `http://localhost:${state.webPort}`,
    WRENLY_APP_URL: `http://localhost:${state.apiPort}`,
    WRENLY_PREVIEW_ENABLED: String(state.previews),
    WRENLY_PREVIEW_GATEWAY_PORT: String(state.previewPort),
    WRENLY_APP_DATABASES_ENABLED: String(state.databases),
    WRENLY_FRAMEWORK_INSPECTION_ENABLED: String(state.inspection),
    WRENLY_DICTATION_ENABLED: String(state.dictation),
    ...(state.dictation
      ? {
          WRENLY_DICTATION_MODEL_PATH: join(
            state.directory,
            ".wrenly",
            "speech",
            SPEECH_MODEL_FILENAME,
          ),
        }
      : {}),
  }))
    if (values.get(name) !== value)
      throw new Error(
        "Installation addresses changed. Use the saved configuration before continuing.",
      );
  if (
    (await readPrivate(join(state.directory, "apps/web/.env.local"))) !==
    `NEXT_PUBLIC_WEB_URL=http://localhost:${state.webPort}\nNEXT_PUBLIC_API_URL=http://127.0.0.1:${state.apiPort}\nNEXT_PUBLIC_DOCS_URL=https://www.usewrenly.org/docs\n`
  )
    throw new Error(
      "Browser addresses changed. Restore the installation configuration before continuing.",
    );
}
async function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}
export async function startRuntime(state: State): Promise<void> {
  const current = await runtimeRequest(state, "status");
  if (current?.status === "running") return;
  if (current)
    throw new Error(
      "The runtime is still starting or stopping. Inspect status first.",
    );
  for (const port of [
    state.webPort,
    state.apiPort,
    ...(state.previews ? [state.previewPort] : []),
  ])
    if (!(await freePort(port)))
      throw new Error(
        `Port ${port} is occupied. No process was adopted or stopped.`,
      );
  const child = spawn(
    process.execPath,
    [
      "--no-env-file",
      join(state.directory, ".wrenly", "operator.js"),
      "_serve",
      state.directory,
      state.id,
    ],
    {
      cwd: state.directory,
      env: cleanEnvironment(),
      detached: true,
      stdio: "ignore",
    },
  );
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  child.unref();
  const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
  while (Date.now() < deadline && !failed) {
    await Bun.sleep(RUNTIME_POLL_MS);
    const reply = await runtimeRequest(state, "status");
    if (reply?.status === "running") return;
    if (reply && ["stopped", "failed"].includes(reply.status)) break;
  }
  throw new Error(
    "Startup was not confirmed. Use status before repeating; no other process will be adopted.",
  );
}
export async function inspectInstallationStatus(directory: string): Promise<{
  id: string;
  phase: string;
  database: string;
  runtime: Reply | null;
  steps: State["steps"];
  url: string;
}> {
  const state = await readState(directory);
  await verifyConfiguration(state);
  return {
    id: state.id,
    phase: state.phase,
    database: await inspectDatabase(state),
    runtime: await runtimeRequest(state, "status"),
    steps: state.steps,
    url: `http://localhost:${state.webPort}`,
  };
}
export async function changeInstallationRuntime(
  directory: string,
  action: "start" | "stop",
): Promise<void> {
  const state = await readState(directory);
  const release = await acquireInstallationLock(directory);
  try {
    await verifyConfiguration(state);
    if (state.steps.schema !== "completed")
      throw new Error(
        "Finish the installation with resume before starting services.",
      );
    if (action === "start") {
      await startDatabase(state);
      await startRuntime(state);
      state.phase = "ready";
    } else {
      const reply = await runtimeRequest(state, "stop");
      if (reply && reply.status !== "stopped")
        throw new Error(
          "Application stop remains unconfirmed; database left running.",
        );
      if (!reply) {
        for (const port of [
          state.webPort,
          state.apiPort,
          ...(state.previews ? [state.previewPort] : []),
        ]) {
          if (!(await freePort(port)))
            throw new Error(
              "Runtime ownership is unconfirmed. Database left running; no process was adopted or stopped.",
            );
        }
      }
      await stopDatabase(state);
      state.phase = "stopped";
    }
    await saveState(state);
  } finally {
    await release();
  }
}
function publicSetupUrl(webPort: number): string {
  const url = new URL("/setup", `http://localhost:${webPort}`);
  if (url.hash !== "" || url.search !== "")
    throw new Error("Setup browser URL must not carry parameters or tokens.");
  return url.href;
}
/** Never auto-launch a blank /setup tab or pass setup proofs to a desktop opener. */
export async function offerSetupBrowserHandoff(
  webPort: number,
  handoff: BrowserHandoff,
): Promise<void> {
  const url = publicSetupUrl(webPort);
  handoff.write(
    `Open the private setup link printed above (or visit ${url} manually if copying the code).\n`,
  );
}
async function readPrivateSetupUrl(
  directory: string,
  expectedOrigin: string,
): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--env-file=${join(directory, ".env")}`,
      "src/modules/auth/setup/setup-cli.ts",
    ],
    {
      cwd: join(directory, "apps/api"),
      env: cleanEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), OWNER_SETUP_TIMEOUT_MS);
  try {
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > MAX_SETUP_OUTPUT_BYTES) {
          throw new Error("Owner setup reply exceeded bounds.");
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error("Owner setup link could not be generated.");
    }
    const expectedPrefix = `${expectedOrigin}/setup#setup=`;
    const setupUrl = Buffer.concat(chunks)
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line.startsWith(expectedPrefix) &&
          /^[A-Za-z0-9_-]+$/.test(line.slice(expectedPrefix.length)),
      );
    if (!setupUrl) {
      throw new Error("Owner setup link was not returned by setup helper.");
    }
    return setupUrl;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

/** Native Better Auth setup prints its short-lived link only to an explicitly interactive terminal. */
export async function openOwnerSetup(
  directory: string,
  interactive: boolean,
  write: (text: string) => void = (text) => process.stdout.write(text),
  decorated = false,
): Promise<void> {
  if (!interactive)
    throw new Error(
      "Owner setup requires an interactive terminal so its private link is not captured in JSON or logs.",
    );
  const state = await readState(directory);
  const release = await acquireInstallationLock(directory);
  let setupUrl: string;
  try {
    await verifyConfiguration(state);
    const runtime = await runtimeRequest(state, "status");
    if (runtime?.status !== "running")
      throw new Error("Start this installation before opening owner setup.");
    setupUrl = await readPrivateSetupUrl(
      directory,
      `http://localhost:${state.webPort}`,
    );
  } finally {
    await release();
  }
  write(renderOwnerSetupLink(setupUrl, state.directory, decorated));
}
