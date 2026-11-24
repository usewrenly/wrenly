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
import { cleanEnvironment, runCommand } from "../runtime/process";
import {
  inspectDatabase,
  startDatabase,
  stopDatabase,
} from "../runtime/compose";
import { acquireInstallationLock } from "../runtime/lock";
const RUNTIME_START_TIMEOUT_MS = 100000;
const RUNTIME_POLL_MS = 500;
const OWNER_SETUP_TIMEOUT_MS = 30000;
const BROWSER_OPEN_TIMEOUT_MS = 5000;
const SAFE_DESKTOP_ENVIRONMENT = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
] as const;

export interface BrowserHandoff {
  desktop: boolean;
  open(url: string): Promise<boolean>;
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
/** Automatically open only the token-free public setup page on local desktops so the one-time token never enters opener command arguments. */
export async function offerSetupBrowserHandoff(
  webPort: number,
  handoff: BrowserHandoff,
): Promise<void> {
  const url = publicSetupUrl(webPort);
  if (!handoff.desktop) {
    handoff.write(
      `Open ${url} in your browser and use the private setup link printed above.\n`,
    );
    return;
  }
  const opened = await handoff.open(url);
  if (opened)
    handoff.write(
      `Opened ${url} in your browser. Keep the private setup link printed above to complete setup.\n`,
    );
  else
    handoff.write(
      `Could not open a browser automatically. Open ${url} and use the private setup link printed above.\n`,
    );
}
async function openPublicSetupBrowser(url: string, cwd: string): Promise<boolean> {
  if (url.includes("#") || url.includes("?")) return false;
  const env = cleanEnvironment();
  for (const key of SAFE_DESKTOP_ENVIRONMENT) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("xdg-open", [url], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
      finish(false);
    }, BROWSER_OPEN_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.unref();
  });
}
/** Native Better Auth setup prints its short-lived link only to an explicitly interactive terminal. */
export async function openOwnerSetup(
  directory: string,
  interactive: boolean,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  if (!interactive)
    throw new Error(
      "Owner setup requires an interactive terminal so its private link is not captured in JSON or logs.",
    );
  const state = await readState(directory);
  const release = await acquireInstallationLock(directory);
  try {
    await verifyConfiguration(state);
    const runtime = await runtimeRequest(state, "status");
    if (runtime?.status !== "running")
      throw new Error("Start this installation before opening owner setup.");
    await runCommand(
      [
        process.execPath,
        "--no-env-file",
        `--env-file=${join(directory, ".env")}`,
        "src/modules/auth/setup/setup-cli.ts",
      ],
      join(directory, "apps/api"),
      OWNER_SETUP_TIMEOUT_MS,
      true,
    );
  } finally {
    await release();
  }
  await offerSetupBrowserHandoff(state.webPort, {
    desktop: Boolean(
      process.stdin.isTTY &&
        process.stdout.isTTY &&
        (process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    ),
    open: (url) => openPublicSetupBrowser(url, state.directory),
    write,
  });
}
