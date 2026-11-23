#!/usr/bin/env -S bun --no-env-file
/** Entrypoints are inert when imported; interactive setup is explicit and local. */
import { createTerminalWriter, supportsDecoration } from "./presentation";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "./arguments";
import { inspectInstallation } from "./doctor";
import { createLocalProbes } from "./probes";
import type { Probes, Options, Report } from "./contracts";
import { installNew, resumeInstallation } from "./commands/installation";
import {
  inspectInstallationStatus,
  changeInstallationRuntime,
  openOwnerSetup,
} from "./commands/management";
import { serveInstallation } from "./runtime/supervisor";
const HELP = `Wrenly · guided local setup

  USAGE
    bunx @wrenly/cli [command] [options]

  COMMANDS
    install      Prepare a verified release, database and local services
    doctor       Check host prerequisites, ports and disk space
    plan         Preview the exact installation actions without changes
    status       Inspect the installation journal, database and runtime
    start        Start the installation's PostgreSQL and local runtime
    stop         Stop services while preserving all data and keys
    resume       Continue an interrupted installation safely
    setup        Print a one-time owner onboarding link in the terminal
    help         Display this command reference

  OPTIONS
    --directory <path>       Absolute installation folder (default: ~/wrenly)
    --web-port <port>        Browser port (default: 3000)
    --api-port <port>        API port (default: 3002)
    --database-port <port>   PostgreSQL port (default: 65433)
    --previews               Prepare isolated local preview containers
    --preview-port <port>    Preview gateway port (default: 3003)
    --laravel                Build the Laravel 13 FrankenPHP runtime image
    --databases              Prepare Development app databases (enables previews)
    --archive <file>         Use a pre-downloaded verified release tarball
    --json                   Output structured JSON (doctor, plan, status)
    --yes                    Confirm non-interactive execution after reviewing plan

  NOTES
    Running without arguments in an interactive terminal opens the guided wizard.
    Stop preserves data. This version does not upgrade or uninstall an instance.
    Optional major updates: https://www.usewrenly.org/#join (browser only; no CLI email collection).
`;
function renderReport(report: Report, write: (text: string) => void): void {
  write("Wrenly · installation checks\n\n");
  for (const check of report.checks) {
    const label = check.status.toUpperCase();
    const gap = " ".repeat(Math.max(2, 13 - label.length));
    const dots = ".".repeat(Math.max(3, 22 - check.name.length));
    write(
      `${label}${gap}${check.name} ${dots} ${check.message}\n${check.remedy ? `  ↳ ${check.remedy}\n` : ""}`,
    );
  }
  if (report.plan) {
    write("\nINSTALLATION PLAN\n");
    for (const item of report.plan) write(`  • ${item}\n`);
  }
  write(
    `\n${report.ready ? "Prerequisites passed." : "Resolve the failed or unconfirmed checks before installing."}\n`,
  );
}
async function confirm(action: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Review plan first, then use --yes for non-interactive execution.",
    );
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    if (
      (await terminal.question(`Type ${action} to continue: `)).trim() !==
      action
    )
      throw new Error("Cancelled. No action was started.");
  } finally {
    terminal.close();
  }
}
async function manage(
  options: Options,
  write: (text: string) => void,
): Promise<number> {
  if (options.command === "status") {
    const status = await inspectInstallationStatus(options.directory);
    write(
      options.json
        ? JSON.stringify(status) + "\n"
        : `Wrenly ${status.id}\nInstallation: ${status.phase}\nDatabase: ${status.database}\nRuntime: ${status.runtime?.status ?? "not running"}\nBrowser: ${status.url}\n`,
    );
    return status.runtime?.status === "running" ? 0 : 1;
  }
  if (options.command === "setup") {
    await openOwnerSetup(
      options.directory,
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
      write,
    );
    return 0;
  }
  await confirm(options.command, options.yes);
  if (options.command === "resume") {
    const state = await resumeInstallation(options.directory, write);
    write(
      `Ready: http://localhost:${state.webPort}\nRun wrenly setup --directory ${JSON.stringify(state.directory)} to create the first owner.\n`,
    );
  } else if (options.command === "start" || options.command === "stop") {
    await changeInstallationRuntime(options.directory, options.command);
    write(
      options.command === "stop"
        ? "Stopped. Your data and configuration are preserved.\n"
        : "Started. Use status to check your instance.\n",
    );
  }
  return 0;
}
export async function runCli(
  args: string[],
  write: (text: string) => void,
  probes: Probes = createLocalProbes(),
  defaultDirectory = join(homedir(), "wrenly"),
): Promise<number> {
  let options: Options;
  try {
    options = parseArguments(args, defaultDirectory);
  } catch (error) {
    write(`${error instanceof Error ? error.message : "Invalid arguments."}\n`);
    return 2;
  }
  if (options.command === "help") {
    write(HELP);
    return 0;
  }
  try {
    if (!["doctor", "plan", "install"].includes(options.command))
      return await manage(options, write);
    const report = await inspectInstallation(
      { ...options, command: options.command === "doctor" ? "doctor" : "plan" },
      probes,
    );
    if (options.command !== "install") {
      report.command = options.command === "plan" ? "plan" : "doctor";
      if (options.json) write(JSON.stringify(report) + "\n");
      else renderReport(report, write);
      return report.ready ? 0 : 1;
    }
    renderReport(report, write);
    if (!report.ready) return 1;
    await confirm("install", options.yes);
    const state = await installNew(options, import.meta.path, write);
    write(
      `\nWrenly is running: http://localhost:${state.webPort}\nConfiguration: ${join(state.directory, ".env")} (keep this private and back it up).\n${state.databases ? "Development app databases are prepared. Approve project storage and migration changes in the conversation." : "Development app databases are off; choose --databases during a new installation to prepare them."}\nProduction databases and publishing require separate connection setup.\nOptional major updates: https://www.usewrenly.org/#join (subscribe in your browser).\n`,
    );
    if (process.stdin.isTTY && process.stdout.isTTY)
      await openOwnerSetup(state.directory, true, write);
    else
      write(
        `Run wrenly setup --directory ${JSON.stringify(state.directory)} in an interactive terminal for the private owner link.\n`,
      );
    return 0;
  } catch (error) {
    write(
      `${error instanceof Error ? error.message : "Setup could not be completed. Saved configuration and data were preserved."}\n`,
    );
    return 1;
  }
}
async function wizard(write: (text: string) => void): Promise<string[]> {
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    write(
      "Wrenly · your own instance\nCheck this machine, prepare a verified release, then create your owner account in the browser.\n\n",
    );
    const directory =
      (
        await terminal.question(
          `◆  1/5  Installation folder [${join(homedir(), "wrenly")}]: `,
        )
      ).trim() || join(homedir(), "wrenly");
    const web =
      (await terminal.question("│  2/5  Browser port [3000]: ")).trim() || "3000";
    const api =
      (await terminal.question("│       API port [3002]: ")).trim() || "3002";
    const database =
      (await terminal.question("│       Wrenly database port [65433]: ")).trim() ||
      "65433";
    const previews =
      (await terminal.question("│  3/5  Prepare local previews? [y/N]: "))
        .trim()
        .toLowerCase() === "y";
    const laravel =
      (await terminal.question("│  4/5  Prepare the Laravel toolchain? [y/N]: "))
        .trim()
        .toLowerCase() === "y";
    const databases =
      (await terminal.question("◆  5/5  Prepare Development app databases (includes previews)? [y/N]: "))
        .trim().toLowerCase() === "y";
    return [
      "install",
      "--directory",
      directory,
      "--web-port",
      web,
      "--api-port",
      api,
      "--database-port",
      database,
      ...(previews ? ["--previews"] : []),
      ...(laravel ? ["--laravel"] : []),
      ...(databases ? ["--databases"] : []),
    ];
  } finally {
    terminal.close();
  }
}
if (import.meta.main) {
  if (Bun.argv[2] === "_serve") {
    try {
      if (Bun.argv.length !== 5) throw new Error("Invalid supervisor request.");
      await serveInstallation(Bun.argv[3]!, Bun.argv[4]!);
    } catch {
      process.exitCode = 1;
    }
  } else {
    const output = createTerminalWriter(
      (text) => {
        process.stdout.write(text);
      },
      supportsDecoration({
        interactive: Boolean(process.stdout.isTTY),
        noColor: process.env.NO_COLOR,
        term: process.env.TERM,
        ci: process.env.CI,
      }),
    );
    const args =
      Bun.argv.length === 2 && process.stdin.isTTY && process.stdout.isTTY
        ? await wizard(output)
        : Bun.argv.slice(2);
    process.exitCode = await runCli(args, output);
  }
}
