/** Prepare one new destination only after every archive entry and its exact digest were verified. */
import { mkdir, lstat, open, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { inspectArchive } from "./archive";
import { verifyRelease, type Release } from "./release";
import { SPEECH_MODEL_FILENAME } from "./speech-model";
import {
  InstallationState,
  verifyDirectoryPath,
  writeNewPrivate,
  statePath,
  type State,
} from "./state";
const SECRET_BYTES = 32;
export interface Settings {
  directory: string;
  webPort: number;
  apiPort: number;
  databasePort: number;
  previewPort: number;
  previews: boolean;
  laravel: boolean;
  databases?: boolean;
  inspection?: boolean;
  dictation?: boolean;
}
export function createState(settings: Settings, release: Release): State {
  return InstallationState.parse({
    directory: settings.directory,
    webPort: settings.webPort,
    apiPort: settings.apiPort,
    databasePort: settings.databasePort,
    previewPort: settings.previewPort,
    previews: settings.previews || Boolean(settings.databases),
    laravel: settings.laravel || Boolean(settings.inspection),
    databases: settings.databases ?? false,
    inspection: settings.inspection ?? false,
    dictation: settings.dictation ?? false,
    ...release,
    version: 1,
    id: crypto.randomUUID(),
    phase: "prepared",
    steps: {},
  });
}
export function composeDocument(state: State): string {
  return (
    JSON.stringify(
      {
        services: {
          postgres: {
            image: "postgres:16-alpine",
            restart: "unless-stopped",
            environment: {
              POSTGRES_DB: "wrenly",
              POSTGRES_USER: "wrenly",
              POSTGRES_PASSWORD: "${WRENLY_INSTALL_DATABASE_PASSWORD:?}",
            },
            ports: [`127.0.0.1:${state.databasePort}:5432`],
            volumes: ["control-data:/var/lib/postgresql/data"],
            labels: { "io.wrenly.installation-id": state.id },
            healthcheck: {
              test: ["CMD-SHELL", "pg_isready -h127.0.0.1 -U wrenly -d wrenly"],
              interval: "3s",
              timeout: "2s",
              retries: 20,
            },
          },
        },
        volumes: {
          "control-data": { labels: { "io.wrenly.installation-id": state.id } },
        },
      },
      null,
      2,
    ) + "\n"
  );
}
/** All secrets are generated locally and only written to the new private root configuration. */
export async function prepareInstallation(
  settings: Settings,
  release: Release,
  bytes: Uint8Array,
): Promise<State> {
  verifyRelease(bytes, release);
  const files = inspectArchive(bytes, release.revision);
  await verifyDirectoryPath(settings.directory);
  try {
    await access(settings.directory);
    throw new Error(
      "The destination already exists. Use resume only for a verified installation; nothing was overwritten.",
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const state = createState(settings, release);
  await mkdir(state.directory, { mode: 0o700 });
  await mkdir(join(state.directory, ".wrenly"), { mode: 0o700 });
  // This receipt owns the new directory even if extraction is interrupted; partial files are never executed.
  await writeNewPrivate(
    statePath(state.directory),
    JSON.stringify({ ...state, phase: "attention" }) + "\n",
  );
  for (const entry of files) {
    const target = join(state.directory, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("Extraction parent changed.");
    const file = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      entry.executable ? 0o700 : 0o600,
    );
    try {
      await file.writeFile(entry.content);
    } finally {
      await file.close();
    }
  }
  const password = randomBytes(SECRET_BYTES).toString("hex"),
    auth = randomBytes(SECRET_BYTES).toString("hex"),
    encryption = randomBytes(SECRET_BYTES).toString("hex");
  await writeNewPrivate(
    join(state.directory, ".env"),
    [
      `# Wrenly installation ${state.id}`,
      `WRENLY_DATABASE_URL=postgresql://wrenly:${password}@127.0.0.1:${state.databasePort}/wrenly`,
      `WRENLY_INSTALL_DATABASE_PASSWORD=${password}`,
      `WRENLY_AUTH_SECRET=${auth}`,
      `WRENLY_DEPLOY_ENCRYPTION_KEY=${encryption}`,
      `WRENLY_APP_URL=http://localhost:${state.apiPort}`,
      `WRENLY_WEB_URL=http://localhost:${state.webPort}`,
      "WRENLY_API_HOST=127.0.0.1",
      `WRENLY_API_PORT=${state.apiPort}`,
      `WRENLY_DATA_DIR=${join(state.directory, ".wrenly", "data")}`,
      `WRENLY_PREVIEW_ENABLED=${state.previews}`,
      `WRENLY_PREVIEW_BASE_URL=http://wrenly-preview.localhost:${state.previewPort}`,
      `WRENLY_PREVIEW_GATEWAY_PORT=${state.previewPort}`,
      "WRENLY_PUBLISHING_ENABLED=false",
      `WRENLY_APP_DATABASES_ENABLED=${state.databases}`,
      "WRENLY_PRODUCTION_DATABASES_ENABLED=false",
      `WRENLY_FRAMEWORK_INSPECTION_ENABLED=${state.inspection}`,
      `WRENLY_DICTATION_ENABLED=${state.dictation}`,
      ...(state.dictation
        ? [
            `WRENLY_DICTATION_MODEL_PATH=${join(state.directory, ".wrenly", "speech", SPEECH_MODEL_FILENAME)}`,
          ]
        : []),
      "WRENLY_SINGLE_USER_MODE=false",
      "",
    ].join("\n"),
  );
  await writeNewPrivate(
    join(state.directory, "apps/web/.env.local"),
    `NEXT_PUBLIC_WEB_URL=http://localhost:${state.webPort}\nNEXT_PUBLIC_API_URL=http://127.0.0.1:${state.apiPort}\nNEXT_PUBLIC_DOCS_URL=https://www.usewrenly.org/docs\n`,
  );
  await writeNewPrivate(
    join(state.directory, ".wrenly", "compose.json"),
    composeDocument(state),
  );
  const { saveState } = await import("./state");
  await saveState(state);
  return state;
}
