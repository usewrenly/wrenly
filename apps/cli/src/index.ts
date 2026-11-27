#!/usr/bin/env -S bun --no-env-file
/** Entrypoints are inert when imported; interactive setup is explicit and local. */
import {
  createTerminalWriter,
  renderInstallSummary,
  renderStatusReport,
  supportsDecoration,
} from "./presentation";
import { PromptCancelledError, confirmPrompt } from "./prompts";
import { runInstallWizard } from "./wizard";
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

const CANCEL_EXIT_CODE = 130;

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

  SETUP
    --directory <path>       Absolute installation folder (default: ~/wrenly)
    --web-port <port>        Browser port (default: 3000)
    --api-port <port>        API port (default: 3002)
    --database-port <port>   PostgreSQL port (default: 65433)
    --preview-port <port>    Preview gateway port (default: 3003)

  CAPABILITIES
    --preset <name>          minimal | recommended | full
      minimal                Next.js 16 core workspace only
      recommended            Next.js 16 + Laravel 13, previews, app databases, inspection
      full                   recommended + local voice dictation
    --previews               Prepare isolated local preview containers
    --laravel                Build the Laravel 13 FrankenPHP runtime image
    --databases              Prepare Development app databases (enables previews)
    --inspection             Build official Laravel & Next.js MCP inspection images
    --dictation              Download Whisper weights and build dictation runtime

  AUTOMATION
    --archive <file>         Use a pre-downloaded verified release tarball
    --json                   Output structured JSON (doctor, plan, status)
    --yes                    Confirm non-interactive execution without prompts

  EXAMPLES
    bunx @wrenly/cli                                   Interactive guided setup
    bunx @wrenly/cli install --preset recommended --yes Scripted recommended install
    bunx @wrenly/cli doctor                            Verify host prerequisites

  NOTES
    Running without arguments or install without --yes opens interactive prompts on a TTY.
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

async function confirm(
  action: string,
  yes: boolean,
  decorated: boolean,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Review plan first, then use --yes for non-interactive execution.",
    );
  const accepted = await confirmPrompt(
    { message: `Continue with ${action}?`, initial: false },
    { input: process.stdin, output: process.stdout },
    decorated,
  );
  if (!accepted) throw new PromptCancelledError("Cancelled. No action was started.");
}

async function manage(
  options: Options,
  write: (text: string) => void,
  decorated: boolean,
): Promise<number> {
  if (options.command === "status") {
    const status = await inspectInstallationStatus(options.directory);
    write(
      options.json
        ? JSON.stringify(status) + "\n"
        : renderStatusReport(status, decorated, process.stdout.columns ?? 80),
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
  await confirm(options.command, options.yes, decorated);
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
  decorated = false,
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
      return await manage(options, write, decorated);
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
    await confirm("install", options.yes, decorated);
    const state = await installNew(options, import.meta.path, write);
    write(
      renderInstallSummary(
        state,
        decorated,
        typeof process.stdout.columns === "number" ? process.stdout.columns : 80,
      ),
    );
    if (process.stdin.isTTY && process.stdout.isTTY)
      await openOwnerSetup(state.directory, true, write);
    else
      write(
        `Run wrenly setup --directory ${JSON.stringify(state.directory)} in an interactive terminal for the private owner link.\n`,
      );
    return 0;
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      write(`${error.message}\n`);
      return CANCEL_EXIT_CODE;
    }
    write(
      `${error instanceof Error ? error.message : "Setup could not be completed. Saved configuration and data were preserved."}\n`,
    );
    return 1;
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
    const decorated = supportsDecoration({
      interactive: Boolean(process.stdout.isTTY),
      noColor: process.env.NO_COLOR,
      term: process.env.TERM,
      ci: process.env.CI,
    });
    const output = createTerminalWriter((text) => {
      process.stdout.write(text);
    }, decorated);
    const rawArgs = Bun.argv.slice(2);
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const shouldRunWizard =
      interactive &&
      (rawArgs.length === 0 ||
        (rawArgs[0] === "install" && !rawArgs.includes("--yes")));
    try {
      const args = shouldRunWizard
        ? await runInstallWizard(
            rawArgs,
            { input: process.stdin, output: process.stdout },
            createLocalProbes(),
            decorated,
            join(homedir(), "wrenly"),
          )
        : rawArgs;
      process.exitCode = await runCli(
        args,
        output,
        createLocalProbes(),
        join(homedir(), "wrenly"),
        decorated,
      );
    } catch (error) {
      if (error instanceof PromptCancelledError) {
        output(`${error.message}\n`);
        process.exitCode = CANCEL_EXIT_CODE;
      } else {
        output(
          `${error instanceof Error ? error.message : "Invalid arguments."}\n`,
        );
        process.exitCode = 2;
      }
    }
  }
}
