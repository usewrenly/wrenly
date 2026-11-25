/** Parse a strict command allowlist before inspecting or changing an installation. */
import { isAbsolute, normalize } from "node:path";
import type { InstallPreset, Options } from "./contracts";
const MAX_PATH_LENGTH = 4096;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const CAPABILITY_FLAGS = [
  "--previews",
  "--laravel",
  "--databases",
  "--inspection",
  "--dictation",
] as const;
const PRESET_VALUES: readonly InstallPreset[] = [
  "minimal",
  "recommended",
  "full",
];
export function parseArguments(
  args: string[],
  defaultDirectory: string,
): Options {
  const first = args[0] ?? "help";
  const command = first === "--help" || first === "-h" ? "help" : first;
  if (
    ![
      "doctor",
      "plan",
      "help",
      "install",
      "resume",
      "status",
      "start",
      "stop",
      "setup",
    ].includes(command)
  )
    throw new Error(
      "Use doctor, plan, install, resume, status, start, stop, setup or help.",
    );
  const result: Options = {
    command: command as Options["command"],
    directory: defaultDirectory,
    webPort: 3000,
    apiPort: 3002,
    json: false,
    yes: false,
    databasePort: 65433,
    previewPort: 3003,
    previews: false,
    laravel: false,
    databases: false,
    inspection: false,
    dictation: false,
  };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (
      [
        "--yes",
        "--previews",
        "--laravel",
        "--databases",
        "--inspection",
        "--dictation",
      ].includes(flag)
    ) {
      if (flag === "--yes") result.yes = true;
      else if (flag === "--previews") result.previews = true;
      else if (flag === "--laravel") result.laravel = true;
      else if (flag === "--databases") result.databases = true;
      else if (flag === "--inspection") result.inspection = true;
      else result.dictation = true;
      continue;
    }
    if (flag === "--json") {
      result.json = true;
      continue;
    }
    if (
      ![
        "--directory",
        "--web-port",
        "--api-port",
        "--database-port",
        "--preview-port",
        "--archive",
        "--preset",
      ].includes(flag)
    )
      throw new Error("Unknown option. Use help for supported options.");
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}.`);
    if (flag === "--preset") {
      if (!PRESET_VALUES.includes(value as InstallPreset))
        throw new Error("Choose minimal, recommended, or full for --preset.");
      result.preset = value as InstallPreset;
      continue;
    }
    if (flag === "--directory" || flag === "--archive") {
      if (
        !isAbsolute(value) ||
        value.length > MAX_PATH_LENGTH ||
        [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new Error(
          "Choose an absolute directory without control characters.",
        );
      if (flag === "--archive") result.archive = normalize(value);
      else result.directory = normalize(value);
    } else {
      const port = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isInteger(port) ||
        port < MIN_PORT ||
        port > MAX_PORT
      )
        throw new Error("Choose a port between 1024 and 65535.");
      if (flag === "--web-port") result.webPort = port;
      else if (flag === "--api-port") result.apiPort = port;
      else if (flag === "--database-port") result.databasePort = port;
      else result.previewPort = port;
    }
  }
  if (seen.has("--preset") && !["install", "plan"].includes(command))
    throw new Error("--preset is supported only with install and plan.");
  if (
    result.preset &&
    CAPABILITY_FLAGS.some((capability) => seen.has(capability))
  )
    throw new Error(
      "Use either --preset or individual capability flags, not both.",
    );
  if (result.preset === "recommended" || result.preset === "full") {
    result.previews = true;
    result.laravel = true;
    result.databases = true;
    result.inspection = true;
  }
  if (result.preset === "full") result.dictation = true;
  // Development app databases use the isolated preview runtime, so the reviewed plan includes both.
  if (result.databases) result.previews = true;
  // Official Laravel Boost inspection depends on the wrenly Laravel toolchain image.
  if (result.inspection) result.laravel = true;
  if (
    new Set([
      result.webPort,
      result.apiPort,
      result.databasePort,
      ...(result.previews ? [result.previewPort] : []),
    ]).size !== (result.previews ? 4 : 3)
  )
    throw new Error("Each enabled service needs a different port.");
  if (
    ["status", "start", "stop", "setup", "resume"].includes(command) &&
    [...seen].some((flag) => !["--directory", "--json", "--yes"].includes(flag))
  )
    throw new Error(
      "Existing installations use their saved ports and settings; these commands accept only --directory, --json and --yes.",
    );
  if (result.json && !["doctor", "plan", "status"].includes(command))
    throw new Error("Only doctor, plan and status support JSON output.");
  return result;
}
