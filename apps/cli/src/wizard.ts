/** Interactive installation wizard that skips prompts for any explicitly provided flags. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { parseArguments } from "./arguments";
import type { InstallPreset, Probes } from "./contracts";
import {
  MUTED,
  RESET,
  WOOD,
  renderBrandHeader,
  renderWizardSummary,
} from "./presentation";
import {
  PromptCancelledError,
  confirmPrompt,
  multiselectPrompt,
  selectPrompt,
  textPrompt,
  type PromptIO,
} from "./prompts";

const MAX_PATH_LENGTH = 4096;
const MAX_CONTROL_SOCKET_PATH_BYTES = 100;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const PORT_SCAN_LIMIT = 50;
const PATH_ALLOWED = /^\/[A-Za-z0-9_./-]+$/;

type CapabilityKey =
  | "previews"
  | "laravel"
  | "databases"
  | "inspection"
  | "dictation";

interface CapabilityState {
  previews: boolean;
  laravel: boolean;
  databases: boolean;
  inspection: boolean;
  dictation: boolean;
}

function collectSeenFlags(args: string[]): Set<string> {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("--")) continue;
    seen.add(token);
    if (
      [
        "--directory",
        "--archive",
        "--web-port",
        "--api-port",
        "--database-port",
        "--preview-port",
        "--preset",
      ].includes(token)
    ) {
      index++;
    }
  }
  return seen;
}

function formatLine(text: string, decorated: boolean): string {
  return decorated ? `  ${WOOD}│${RESET}  ${text}\n` : `  │  ${text}\n`;
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
}

function matchingPreset(state: CapabilityState): InstallPreset | undefined {
  if (
    !state.previews &&
    !state.laravel &&
    !state.databases &&
    !state.inspection &&
    !state.dictation
  )
    return "minimal";
  if (
    state.previews &&
    state.laravel &&
    state.databases &&
    state.inspection &&
    !state.dictation
  )
    return "recommended";
  if (
    state.previews &&
    state.laravel &&
    state.databases &&
    state.inspection &&
    state.dictation
  )
    return "full";
  return undefined;
}

function summarizeCapabilities(state: CapabilityState): string {
  const enabled: string[] = [];
  if (state.previews) enabled.push("Local previews");
  if (state.laravel) enabled.push("Laravel 13 toolchain");
  if (state.databases) enabled.push("Development app databases");
  if (state.inspection) enabled.push("Framework inspection");
  if (state.dictation) enabled.push("Voice dictation");
  return enabled.length > 0 ? enabled.join(", ") : "Core workspace only";
}

function validatePortInput(raw: string, used: Set<number>): string | undefined {
  if (!/^\d+$/.test(raw.trim())) return "Enter a port number between 1024 and 65535.";
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)
    return "Choose a port between 1024 and 65535.";
  if (used.has(port)) return `Port ${port} is already assigned to another service.`;
  return undefined;
}

async function findNextFreePort(
  start: number,
  used: Set<number>,
  probes: Probes,
): Promise<number> {
  for (let offset = 1; offset <= PORT_SCAN_LIMIT; offset++) {
    const candidate = start + offset;
    if (candidate > MAX_PORT) break;
    if (used.has(candidate)) continue;
    if ((await probes.port(candidate)) === true) return candidate;
  }
  return start;
}

function normalizeDirectoryInput(raw: string, cwd: string): string {
  const trimmed = raw.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded)
    ? normalize(expanded)
    : normalize(resolve(cwd, expanded));
}

function suggestInstallDirectory(
  cwd: string,
  defaultDirectory: string,
): string {
  const localCandidate = join(cwd, "wrenly");
  const isSourceCheckout = existsSync(join(cwd, "turbo.json"));
  if (
    cwd !== homedir() &&
    !isSourceCheckout &&
    Buffer.byteLength(join(localCandidate, ".wrenly", "control.sock")) <=
      MAX_CONTROL_SOCKET_PATH_BYTES
  ) {
    return localCandidate;
  }
  return defaultDirectory;
}

/** Runs the interactive installation flow and returns resolved non-interactive install arguments. */
export async function runInstallWizard(
  args: string[],
  io: PromptIO,
  probes: Probes,
  decorated: boolean,
  defaultDirectory: string,
  cwd: string = process.cwd(),
): Promise<string[]> {
  const normalizedInput =
    args.length === 0
      ? ["install"]
      : args[0] === "install"
        ? args
        : ["install", ...args];
  const parsed = parseArguments(normalizedInput, defaultDirectory);
  const seen = collectSeenFlags(normalizedInput.slice(1));

  io.output.write(renderBrandHeader("guided setup", decorated));

  let directory = parsed.directory;
  if (!seen.has("--directory")) {
    const suggestedDirectory = suggestInstallDirectory(cwd, defaultDirectory);
    const chosen = await textPrompt(
      {
        message: "Installation folder",
        placeholder: suggestedDirectory,
        hint: "type a path or press enter for default · ctrl+c cancel",
        validate: async (raw) => {
          const trimmed = raw.trim();
          if (
            !trimmed ||
            [...trimmed].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          ) {
            return "Choose a valid path using letters, numbers, '/', '.', '-', or '_'.";
          }
          const resolved = normalizeDirectoryInput(trimmed, cwd);
          if (
            !isAbsolute(resolved) ||
            resolved.length > MAX_PATH_LENGTH ||
            !PATH_ALLOWED.test(resolved) ||
            Buffer.byteLength(join(resolved, ".wrenly", "control.sock")) >
              MAX_CONTROL_SOCKET_PATH_BYTES
          ) {
            return "Choose a shorter path using simple directory names (100-byte socket limit).";
          }
          const destination = await probes.destination(resolved);
          if (destination === "existing")
            return "That folder already exists — enter a new subfolder (e.g. ./wrenly) or press Enter for default.";
          if (destination === "unsafe")
            return "That folder uses a symlink or unsafe parent permissions.";
          if (destination === "unconfirmed")
            return "Could not confirm that folder is empty and safe to create.";
          return undefined;
        },
      },
      io,
      decorated,
    );
    directory = normalizeDirectoryInput(chosen, cwd);
  }

  const capabilities: CapabilityState = {
    previews: parsed.previews,
    laravel: parsed.laravel,
    databases: parsed.databases,
    inspection: parsed.inspection,
    dictation: parsed.dictation,
  };

  const hasExplicitCapabilities =
    seen.has("--preset") ||
    seen.has("--previews") ||
    seen.has("--laravel") ||
    seen.has("--databases") ||
    seen.has("--inspection") ||
    seen.has("--dictation");

  if (!hasExplicitCapabilities) {
    const mode = await selectPrompt<InstallPreset | "custom">(
      {
        message: "Setup profile",
        initial: "recommended",
        options: [
          {
            value: "recommended",
            label: "Recommended",
            hint: "Next.js 16 + Laravel 13, previews, app databases, inspection",
          },
          {
            value: "full",
            label: "Everything",
            hint: "adds local voice dictation (~148 MB download)",
          },
          {
            value: "minimal",
            label: "Minimal",
            hint: "Next.js 16 core workspace only",
          },
          {
            value: "custom",
            label: "Custom",
            hint: "choose optional capabilities (Next.js 16 always included)",
          },
        ],
      },
      io,
      decorated,
    );

    if (mode === "recommended") {
      capabilities.previews = true;
      capabilities.laravel = true;
      capabilities.databases = true;
      capabilities.inspection = true;
    } else if (mode === "full") {
      capabilities.previews = true;
      capabilities.laravel = true;
      capabilities.databases = true;
      capabilities.inspection = true;
      capabilities.dictation = true;
    } else if (mode === "custom") {
      const picked = await multiselectPrompt<CapabilityKey>(
        {
          message: "Select optional capabilities",
          initial: [],
          options: [
            {
              value: "previews",
              label: "Local previews",
              hint: "run generated apps in isolated containers",
            },
            {
              value: "laravel",
              label: "Laravel 13 toolchain",
              hint: "FrankenPHP · PHP 8.4 runtime image",
            },
            {
              value: "databases",
              label: "Development app databases",
              hint: "PostgreSQL per project · includes previews",
            },
            {
              value: "inspection",
              label: "Framework inspection",
              hint: "Laravel Boost & Next.js DevTools · includes Laravel",
            },
            {
              value: "dictation",
              label: "Voice dictation",
              hint: "local Whisper · ~148 MB download",
            },
          ],
        },
        io,
        decorated,
      );
      capabilities.previews = picked.includes("previews");
      capabilities.laravel = picked.includes("laravel");
      capabilities.databases = picked.includes("databases");
      capabilities.inspection = picked.includes("inspection");
      capabilities.dictation = picked.includes("dictation");

      const implied: string[] = [];
      if (capabilities.databases && !capabilities.previews) {
        capabilities.previews = true;
        implied.push("Local previews (required by Development app databases)");
      }
      if (capabilities.inspection && !capabilities.laravel) {
        capabilities.laravel = true;
        implied.push("Laravel 13 toolchain (required by Framework inspection)");
      }
      if (implied.length > 0) {
        const note = `Also enabled: ${implied.join(", ")}`;
        io.output.write(
          formatLine(decorated ? `${MUTED}${note}${RESET}` : note, decorated),
        );
      }
    }
  }

  let webPort = parsed.webPort;
  let apiPort = parsed.apiPort;
  let databasePort = parsed.databasePort;
  let previewPort = parsed.previewPort;

  const hasAnyPortFlag =
    seen.has("--web-port") ||
    seen.has("--api-port") ||
    seen.has("--database-port") ||
    seen.has("--preview-port");

  if (!hasAnyPortFlag) {
    const services: Array<{
      key: "web" | "api" | "database" | "preview";
      label: string;
      port: number;
    }> = [
      { key: "web", label: "Browser port", port: webPort },
      { key: "api", label: "API port", port: apiPort },
      { key: "database", label: "Wrenly database port", port: databasePort },
      ...(capabilities.previews
        ? [{ key: "preview" as const, label: "Preview port", port: previewPort }]
        : []),
    ];
    const probeResults = await Promise.all(
      services.map(async (service) => ({
        service,
        free: (await probes.port(service.port)) === true,
      })),
    );
    const busy = probeResults.filter((item) => !item.free);
    const claimSet = new Set(services.map((item) => item.port));

    if (busy.length === 0) {
      const useDefaults = await confirmPrompt(
        {
          message: `Use default ports? ${services.map((s) => s.port).join(" · ")}`,
          initial: true,
        },
        io,
        decorated,
      );
      if (!useDefaults) {
        const assigned = new Set<number>();
        for (const service of services) {
          const raw = await textPrompt(
            {
              message: service.label,
              initial: String(service.port),
              validate: (value) => validatePortInput(value, assigned),
            },
            io,
            decorated,
          );
          const chosen = Number(raw.trim());
          assigned.add(chosen);
          if (service.key === "web") webPort = chosen;
          else if (service.key === "api") apiPort = chosen;
          else if (service.key === "database") databasePort = chosen;
          else previewPort = chosen;
        }
      }
    } else {
      for (const item of busy) {
        io.output.write(
          formatLine(`Port ${item.service.port} is in use`, decorated),
        );
        claimSet.delete(item.service.port);
      }
      for (const item of busy) {
        const suggested = await findNextFreePort(
          item.service.port,
          claimSet,
          probes,
        );
        const raw = await textPrompt(
          {
            message: item.service.label,
            initial: String(suggested),
            validate: (value) => validatePortInput(value, claimSet),
          },
          io,
          decorated,
        );
        const chosen = Number(raw.trim());
        claimSet.add(chosen);
        if (item.service.key === "web") webPort = chosen;
        else if (item.service.key === "api") apiPort = chosen;
        else if (item.service.key === "database") databasePort = chosen;
        else previewPort = chosen;
      }
    }
  }

  const presetMatch = matchingPreset(capabilities);
  const equivalentFlags: string[] = [
    `--directory ${quoteArg(directory)}`,
    ...(webPort !== 3000 ? [`--web-port ${webPort}`] : []),
    ...(apiPort !== 3002 ? [`--api-port ${apiPort}`] : []),
    ...(databasePort !== 65433 ? [`--database-port ${databasePort}`] : []),
    ...(capabilities.previews && previewPort !== 3003
      ? [`--preview-port ${previewPort}`]
      : []),
    ...(presetMatch
      ? [`--preset ${presetMatch}`]
      : [
          ...(capabilities.previews ? ["--previews"] : []),
          ...(capabilities.laravel ? ["--laravel"] : []),
          ...(capabilities.databases ? ["--databases"] : []),
          ...(capabilities.inspection ? ["--inspection"] : []),
          ...(capabilities.dictation ? ["--dictation"] : []),
        ]),
    ...(parsed.archive ? [`--archive ${quoteArg(parsed.archive)}`] : []),
  ];
  const equivalentCommand = `bunx @wrenly/cli install ${equivalentFlags.join(" ")}`;
  const portSummary = [
    `web ${webPort}`,
    `api ${apiPort}`,
    `db ${databasePort}`,
    ...(capabilities.previews ? [`preview ${previewPort}`] : []),
  ].join(" · ");
  const frameworks = capabilities.laravel
    ? "Next.js 16 + Laravel 13"
    : "Next.js 16";

  io.output.write(
    renderWizardSummary(
      {
        directory,
        frameworks,
        capabilities: summarizeCapabilities(capabilities),
        ports: portSummary,
        equivalentCommand,
      },
      decorated,
      io.output.columns ?? 80,
    ),
  );

  const proceed = await confirmPrompt(
    { message: "Run checks and install now?", initial: true },
    io,
    decorated,
  );
  if (!proceed) throw new PromptCancelledError();

  return [
    "install",
    "--directory",
    directory,
    "--web-port",
    String(webPort),
    "--api-port",
    String(apiPort),
    "--database-port",
    String(databasePort),
    ...(capabilities.previews ? ["--preview-port", String(previewPort)] : []),
    ...(capabilities.previews ? ["--previews"] : []),
    ...(capabilities.laravel ? ["--laravel"] : []),
    ...(capabilities.databases ? ["--databases"] : []),
    ...(capabilities.inspection ? ["--inspection"] : []),
    ...(capabilities.dictation ? ["--dictation"] : []),
    ...(parsed.archive ? ["--archive", parsed.archive] : []),
    "--yes",
  ];
}
