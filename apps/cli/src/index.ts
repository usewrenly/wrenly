#!/usr/bin/env -S bun --no-env-file
/** Entrypoints are inert when imported; interactive setup is explicit and local. */
import {
  BOLD,
  GREEN,
  MUTED,
  RESET,
  createTerminalWriter,
  renderActionResult,
  renderBrandHeader,
  renderDoctorTable,
  renderHelp,
  renderInstallSummary,
  renderPlanTable,
  renderStatusReport,
  supportsDecoration,
} from "./presentation";
import { PromptCancelledError, confirmPrompt } from "./prompts";
import { runInstallWizard } from "./wizard";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "./arguments";
import { inspectInstallation } from "./doctor";
import { CLI_VERSION } from "./install/release";
import { createLocalProbes } from "./probes";
import type { Probes, Options } from "./contracts";
import { installNew, resumeInstallation } from "./commands/installation";
import {
  inspectInstallationStatus,
  changeInstallationRuntime,
  openOwnerSetup,
} from "./commands/management";
import { serveInstallation } from "./runtime/supervisor";

const CANCEL_EXIT_CODE = 130;

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
      decorated,
    );
    return 0;
  }
  await confirm(options.command, options.yes, decorated);
  if (options.command === "resume") {
    const state = await resumeInstallation(options.directory, write);
    write(
      renderActionResult(
        `Ready: http://localhost:${state.webPort} · run setup to create the first owner`,
        decorated,
      ),
    );
  } else if (options.command === "start" || options.command === "stop") {
    await changeInstallationRuntime(options.directory, options.command);
    write(
      renderActionResult(
        options.command === "stop"
          ? "Stopped. Your data and configuration are preserved."
          : "Started. Use status to check your instance.",
        decorated,
      ),
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
  if (options.command === "version") {
    write(`wrenly v${CLI_VERSION}\n`);
    return 0;
  }
  if (options.command === "help") {
    write(renderHelp(decorated));
    return 0;
  }
  const columns =
    typeof process.stdout.columns === "number" ? process.stdout.columns : 80;
  try {
    if (!["doctor", "plan", "install"].includes(options.command))
      return await manage(options, write, decorated);
    const report = await inspectInstallation(
      { ...options, command: options.command === "doctor" ? "doctor" : "plan" },
      probes,
    );
    if (options.command === "doctor") {
      if (options.json) write(JSON.stringify(report) + "\n");
      else {
        write(renderBrandHeader("host prerequisites", decorated));
        write(renderDoctorTable(report, decorated, columns));
      }
      return report.ready ? 0 : 1;
    }
    if (options.command === "plan") {
      report.command = "plan";
      if (options.json) write(JSON.stringify(report) + "\n");
      else {
        write(renderBrandHeader("installation plan", decorated));
        write(renderDoctorTable(report, decorated, columns));
        write("\n");
        write(renderPlanTable(options, decorated, columns, true));
      }
      return report.ready ? 0 : 1;
    }
    if (!report.ready) {
      write("\n");
      write(renderDoctorTable(report, decorated, columns));
      return 1;
    }
    if (!options.yes) {
      write(renderPlanTable(options, decorated, columns, false));
      write("\n");
      await confirm("install", options.yes, decorated);
    }
    write(
      decorated
        ? `  ${GREEN}✔${RESET}  ${BOLD}Preflight checks passed${RESET} ${MUTED}(${report.checks.length}/${report.checks.length})${RESET}\n`
        : `Preflight checks passed (${report.checks.length}/${report.checks.length}).\n`,
    );
    const state = await installNew(options, import.meta.path, write);
    write(renderInstallSummary(state, decorated, columns));
    if (process.stdin.isTTY && process.stdout.isTTY)
      await openOwnerSetup(state.directory, true, write, decorated);
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
