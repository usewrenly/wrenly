#!/usr/bin/env -S bun --no-env-file
/** Standalone entry point; importing this module performs no probes or filesystem writes. */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "./arguments";
import { inspectInstallation } from "./doctor";
import { createLocalProbes } from "./probes";
import type { Probes } from "./contracts";
const HELP = `Wrenly setup candidate — read-only checks

  wrenly doctor [--directory /absolute/path] [--web-port 3000] [--api-port 3002] [--json]
  wrenly plan   [same options]
  wrenly help

No installation or upgrade command is released in this candidate.
`;
export async function runCli(
  args: string[],
  write: (text: string) => void,
  probes: Probes = createLocalProbes(),
  defaultDirectory = join(homedir(), "wrenly"),
): Promise<number> {
  let options;
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
    const report = await inspectInstallation(options, probes);
    if (options.json) write(JSON.stringify(report) + "\n");
    else {
      write("Wrenly · installation checks\n\n");
      for (const check of report.checks)
        write(
          `${check.status.toUpperCase()}  ${check.name}: ${check.message}\n${check.remedy ? `  ${check.remedy}\n` : ""}`,
        );
      if (report.plan) write("\n" + report.plan.join("\n") + "\n");
      write(
        `\n${report.ready ? "Prerequisites passed. This candidate does not install Wrenly yet." : "Resolve the failed or unconfirmed checks before installing."}\n`,
      );
    }
    return report.ready ? 0 : 1;
  } catch {
    write(
      "Machine checks could not be completed. No installation was started.\n",
    );
    return 1;
  }
}
if (import.meta.main)
  process.exitCode = await runCli(Bun.argv.slice(2), (text) => {
    process.stdout.write(text);
  });
