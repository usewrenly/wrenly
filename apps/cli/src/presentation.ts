/** Terminal decoration never changes the underlying messages, JSON or execution decisions. */
import { join } from "node:path";
import type { State } from "./install/state";

export const RESET = "\u001b[0m";
export const WOOD = "\u001b[38;2;176;132;106m";
export const BOLD = "\u001b[1m";
export const MUTED = "\u001b[2m";
export const GREEN = "\u001b[38;2;34;197;94m";
export const RED = "\u001b[38;2;239;68;68m";
export const AMBER = "\u001b[38;2;217;119;6m";
const PASS_PILL =
  "\u001b[48;2;22;101;52m\u001b[38;2;240;253;244m\u001b[1m PASS \u001b[0m";
const FAIL_PILL =
  "\u001b[48;2;153;27;27m\u001b[38;2;254;242;242m\u001b[1m FAIL \u001b[0m";
const WARN_PILL =
  "\u001b[48;2;146;64;14m\u001b[38;2;254;252;232m\u001b[1m WARN \u001b[0m";
const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"] as const;
const SPINNER_INTERVAL_MS = 120;
const MAX_SUMMARY_BOX_WIDTH = 76;
const MIN_SUMMARY_BOX_WIDTH = 44;

const STEP_LABELS: Record<string, string> = {
  dependencies: "Install dependencies",
  "API build": "Build API",
  "web build": "Build web app",
  "Laravel toolchain": "Laravel 13 toolchain",
  "Laravel inspection image": "Laravel Boost inspection image",
  "Next.js inspection image": "Next.js DevTools inspection image",
  "voice dictation model": "Download Whisper speech model",
  "voice dictation image": "Voice dictation runtime image",
  "preview image": "Pull preview runtime image",
  "app PostgreSQL image": "App PostgreSQL 17 image",
  "app database socket image": "App database socket image",
  database: "Start Wrenly PostgreSQL",
  schema: "Apply database migrations",
  runtime: "Start Wrenly",
};

const SECTION_HEADINGS = new Set([
  "  USAGE",
  "  COMMANDS",
  "  SETUP",
  "  CAPABILITIES",
  "  AUTOMATION",
  "  EXAMPLES",
  "  OPTIONS",
  "  NOTES",
  "INSTALLATION PLAN",
]);

export interface TerminalPreferences {
  interactive: boolean;
  noColor: string | undefined;
  term: string | undefined;
  ci: string | undefined;
}

export interface StatusCardInput {
  id: string;
  phase: string;
  database: string;
  url: string;
  runtime: { status: string } | null;
}

/** Plain output remains available for accessibility, logs and automation. */
export function supportsDecoration(preferences: TerminalPreferences): boolean {
  return (
    preferences.interactive &&
    preferences.noColor === undefined &&
    preferences.term !== "dumb" &&
    preferences.ci !== "true"
  );
}

/** Strips CSI ANSI escape sequences so box alignment matches visible width. */
export function stripAnsi(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && text[index] !== "m" && text[index] !== "K" && text[index] !== "A" && text[index] !== "h" && text[index] !== "l" && text[index] !== "J") {
        index++;
      }
      continue;
    }
    result += text[index];
  }
  return result;
}

function banner(title: string): string {
  const inner = `  ${title}  `;
  const width = Math.max(52, inner.length + 2);
  const top = `┌─ wrenly ${"─".repeat(Math.max(2, width - 9))}┐`;
  const mid = `│${inner.padEnd(width)}│`;
  const bot = `└${"─".repeat(width)}┘`;
  return `\n${WOOD}  ${top}${RESET}\n${BOLD}${WOOD}  ${mid}${RESET}\n${WOOD}  ${bot}${RESET}`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

function formatStepLabel(name: string): string {
  return STEP_LABELS[name] ?? name;
}

function quoteDirectoryArg(directory: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(directory)
    ? directory
    : JSON.stringify(directory);
}

function wrapPlainLine(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxWidth) {
    let split = remaining.lastIndexOf(" ", maxWidth);
    if (split <= 12) split = maxWidth;
    lines.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

function renderRoundedBox(
  title: string,
  lines: string[],
  columns: number,
): string {
  const width = Math.min(
    MAX_SUMMARY_BOX_WIDTH,
    Math.max(MIN_SUMMARY_BOX_WIDTH, columns - 2),
  );
  const contentWidth = width - 4;
  const headerPrefix = `╭─ ${title} `;
  const headerFill = Math.max(1, width - headerPrefix.length - 1);
  const top = `${WOOD}${headerPrefix}${"─".repeat(headerFill)}╮${RESET}`;
  const bottom = `${WOOD}╰${"─".repeat(width - 2)}╯${RESET}`;
  const body = lines.map((line) => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, contentWidth - visible);
    return `${WOOD}│${RESET} ${line}${" ".repeat(pad)} ${WOOD}│${RESET}`;
  });
  return `\n${[top, ...body, bottom].map((row) => `  ${row}`).join("\n")}\n`;
}

/** Formats installation completion details without ever embedding setup proofs or tokens. */
export function renderInstallSummary(
  state: State,
  decorated: boolean,
  columns = 80,
): string {
  const directoryArg = quoteDirectoryArg(state.directory);
  const capabilities: Array<{
    enabled: boolean;
    label: string;
    flag: string;
  }> = [
    { enabled: state.previews, label: "Local previews", flag: "--previews" },
    {
      enabled: state.laravel,
      label: "Laravel 13 toolchain",
      flag: "--laravel",
    },
    {
      enabled: state.databases,
      label: "Development app databases",
      flag: "--databases",
    },
    {
      enabled: state.inspection,
      label: "Official framework inspection",
      flag: "--inspection",
    },
    {
      enabled: state.dictation,
      label: "Local voice dictation",
      flag: "--dictation",
    },
  ];
  const plainRows: Array<[string, string[]]> = [
    ["Open", [`http://localhost:${state.webPort}`]],
    ["Folder", [state.directory]],
    ["Config", [`${join(state.directory, ".env")} (private, back it up)`]],
    [
      "Included",
      capabilities.map((item) =>
        item.enabled
          ? `✔ ${item.label}`
          : `○ ${item.label} (new install with ${item.flag})`,
      ),
    ],
    [
      "Next steps",
      [
        "1. Create your owner account (private link below)",
        "2. Settings → Providers → connect a model",
        "3. Describe your first app",
      ],
    ],
    [
      "Manage",
      [`bunx @wrenly/cli status|stop|start --directory ${directoryArg}`],
    ],
    [
      "Publishing",
      [
        "Production databases and publishing are set up separately: usewrenly.org/docs/guides/publishing-setup",
      ],
    ],
    ["Updates", ["https://www.usewrenly.org/#join"]],
  ];
  if (!decorated) {
    const out: string[] = ["\nWrenly is ready\n"];
    for (const [label, values] of plainRows) {
      for (const [index, value] of values.entries()) {
        const prefix = index === 0 ? `${label}:`.padEnd(13) : " ".repeat(13);
        out.push(`${prefix}${value}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
  const boxWidth = Math.min(
    MAX_SUMMARY_BOX_WIDTH,
    Math.max(MIN_SUMMARY_BOX_WIDTH, columns - 2),
  );
  const labelWidth = 12;
  const valueWidth = Math.max(20, boxWidth - 4 - labelWidth);
  const boxLines: string[] = [];
  for (const [label, values] of plainRows) {
    if (label === "Included") {
      for (const [index, cap] of capabilities.entries()) {
        const key =
          index === 0
            ? `${BOLD}${label.padEnd(labelWidth)}${RESET}`
            : " ".repeat(labelWidth);
        const icon = cap.enabled ? `${GREEN}✔${RESET}` : `${MUTED}○${RESET}`;
        const suffix = cap.enabled
          ? ""
          : ` ${MUTED}(new install with ${cap.flag})${RESET}`;
        boxLines.push(`${key}${icon} ${cap.label}${suffix}`);
      }
      continue;
    }
    let firstRow = true;
    for (const rawValue of values) {
      const wrapped = wrapPlainLine(rawValue, valueWidth);
      for (const line of wrapped) {
        const key = firstRow
          ? `${BOLD}${label.padEnd(labelWidth)}${RESET}`
          : " ".repeat(labelWidth);
        firstRow = false;
        const styledValue =
          label === "Open" ? `${BOLD}${WOOD}${line}${RESET}` : line;
        boxLines.push(`${key}${styledValue}`);
      }
    }
  }
  const width = boxWidth;
  const contentWidth = width - 4;
  const title = "Wrenly is ready";
  const headerPrefix = `╭─ ${title} `;
  const headerFill = Math.max(1, width - headerPrefix.length - 1);
  const top = `${WOOD}${headerPrefix}${"─".repeat(headerFill)}╮${RESET}`;
  const bottom = `${WOOD}╰${"─".repeat(width - 2)}╯${RESET}`;
  const body = boxLines.map((line) => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, contentWidth - visible);
    return `${WOOD}│${RESET} ${line}${" ".repeat(pad)} ${WOOD}│${RESET}`;
  });
  return `\n${[top, ...body, bottom].map((row) => `  ${row}`).join("\n")}\n`;
}

/** Formats installation status as a card when decorated or plain lines otherwise. */
export function renderStatusReport(
  status: StatusCardInput,
  decorated: boolean,
  columns = 80,
): string {
  const runtimeStatus = status.runtime?.status ?? "not running";
  if (!decorated) {
    return `Wrenly ${status.id}\nInstallation: ${status.phase}\nDatabase: ${status.database}\nRuntime: ${runtimeStatus}\nBrowser: ${status.url}\n`;
  }
  const rows: Array<[string, string]> = [
    ["Instance", status.id],
    ["Installation", status.phase],
    ["Database", status.database],
    ["Runtime", runtimeStatus],
    ["Browser", status.url],
  ];
  const lines = rows.map(([key, value]) => {
    const paddedKey = `${BOLD}${key.padEnd(14)}${RESET}`;
    const styledValue =
      key === "Runtime" && runtimeStatus === "running"
        ? `${GREEN}${value}${RESET}`
        : value;
    return `${paddedKey}${styledValue}`;
  });
  return renderRoundedBox("Wrenly status", lines, columns);
}

/** Decorate only known headings/labels; private setup links and structured output pass through unchanged. */
export function createTerminalWriter(
  write: (text: string) => void,
  decorated: boolean,
): (text: string) => void {
  if (!decorated) return write;
  let spinner: {
    stepName: string;
    label: string;
    counter: string;
    frameIndex: number;
    startedAt: number;
    timer: ReturnType<typeof setInterval>;
    onExit: () => void;
  } | null = null;

  const clearSpinner = (clearLine: boolean): void => {
    if (!spinner) return;
    clearInterval(spinner.timer);
    process.removeListener("exit", spinner.onExit);
    spinner = null;
    if (clearLine) write("\r\u001b[2K");
  };

  const renderSpinnerFrame = (): void => {
    if (!spinner) return;
    const frame = SPINNER_FRAMES[spinner.frameIndex % SPINNER_FRAMES.length]!;
    const suffix = spinner.counter ? ` ${MUTED}(${spinner.counter})${RESET}` : "";
    write(
      `\r\u001b[2K  ${WOOD}${frame}${RESET} ${BOLD}${spinner.label}${RESET}${suffix}`,
    );
  };

  return (text) => {
    if (text.includes("\u001b")) {
      clearSpinner(true);
      write(text);
      return;
    }
    const parts = text.split("\n");
    const out: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      const line = parts[index]!;
      const hasNewline = index < parts.length - 1;
      const preparing = /^Preparing (.+?)(?: \((\d+\/\d+)\))?…$/.exec(line);
      if (preparing) {
        if (out.length > 0) {
          write(out.join("\n") + "\n");
          out.length = 0;
        }
        clearSpinner(true);
        const stepName = preparing[1]!;
        const counter = preparing[2] ?? "";
        const label = formatStepLabel(stepName);
        const onExit = (): void => {
          if (spinner) {
            clearInterval(spinner.timer);
            spinner = null;
            write("\r\u001b[2K");
          }
        };
        const timer = setInterval(() => {
          if (!spinner) return;
          spinner.frameIndex = (spinner.frameIndex + 1) % SPINNER_FRAMES.length;
          renderSpinnerFrame();
        }, SPINNER_INTERVAL_MS);
        timer.unref();
        process.once("exit", onExit);
        spinner = {
          stepName,
          label,
          counter,
          frameIndex: 0,
          startedAt: Date.now(),
          timer,
          onExit,
        };
        renderSpinnerFrame();
        continue;
      }

      if (line.endsWith(" ready.")) {
        const stepName = line.slice(0, -" ready.".length);
        if (spinner && spinner.stepName === stepName) {
          const elapsed = formatDuration(Date.now() - spinner.startedAt);
          const label = spinner.label;
          clearSpinner(true);
          out.push(
            `  ${WOOD}◆${RESET}  ${BOLD}${label}${RESET} ${MUTED}${elapsed}${RESET}`,
          );
        } else {
          clearSpinner(true);
          out.push(`  ${PASS_PILL}  ${BOLD}${line}${RESET}`);
        }
        if (!hasNewline) {
          write(out.join("\n"));
          out.length = 0;
        }
        continue;
      }

      if (spinner && line.length > 0) clearSpinner(true);

      if (line.startsWith("Wrenly ·")) {
        out.push(banner(line));
      } else if (SECTION_HEADINGS.has(line)) {
        out.push(`  ${BOLD}${WOOD}${line.trim()}${RESET}`);
      } else {
        const check = /^(PASS|FAILED|UNCONFIRMED) {2,}([^.]+?) (\.{3,}) (.*)$/.exec(
          line,
        );
        if (check) {
          const pill =
            check[1] === "PASS"
              ? PASS_PILL
              : check[1] === "FAILED"
                ? FAIL_PILL
                : WARN_PILL;
          out.push(
            `  ${pill}  ${BOLD}${check[2]}${RESET} ${MUTED}${check[3]}${RESET} ${check[4]}`,
          );
        } else if (line.startsWith("  ↳ ")) {
          out.push(
            `         ${AMBER}↳${RESET} ${MUTED}${line.slice(4)}${RESET}`,
          );
        } else if (line.startsWith("  • ")) {
          out.push(`  ${WOOD}│  ◆${RESET} ${line.slice(4)}`);
        } else if (line === "Prerequisites passed.") {
          out.push(`  ${PASS_PILL}  ${BOLD}${line}${RESET}`);
        } else if (
          line === "Resolve the failed or unconfirmed checks before installing."
        ) {
          out.push(`  ${WARN_PILL}  ${BOLD}${line}${RESET}`);
        } else if (
          line.includes(" did not complete.") ||
          line.startsWith("Setup could not be completed") ||
          line.startsWith("Cancelled.")
        ) {
          out.push(`  ${RED}■${RESET}  ${line}`);
        } else if (
          line.startsWith("Destination:") ||
          line.startsWith("Browser:")
        ) {
          out.push(`  ${MUTED}${line}${RESET}`);
        } else {
          out.push(line);
        }
      }
    }
    if (out.length > 0) write(out.join("\n"));
  };
}
