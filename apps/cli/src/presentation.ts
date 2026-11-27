/**
 * COMPONENT: cli-presentation
 * PURPOSE: Render Wrenly's terminal brand header, rounded tables, help manual, progress stream, and summary cards without altering logic or secrets.
 * INPUTS: Check reports, planned options, wizard selections, installation state, and TTY capabilities.
 * OUTPUTS: Styled ANSI output on interactive terminals and clean unstyled text when plain output is requested.
 * STEPS:
 *   1. Detect terminal decoration support and strip ANSI sequences when measuring cell widths.
 *   2. Render the line-art Wrenly bird emblem alongside version and command context.
 *   3. Format doctor, plan, wizard, and help views with rounded Unicode tables or aligned plain columns.
 *   4. Stream step spinners and emit the final card with next steps and browser-only update links.
 * EDGE CASES:
 *   - Narrow terminals (< 80 cols) or long installation paths wrap inside cell bounds without breaking right borders.
 *   - Plain mode (`decorated = false`) emits zero ANSI escapes or Unicode box art so scripts/logs stay readable.
 * ERROR STATES:
 *   - Invalid/unrecognized spinner lines pass through safely; failed checks display clear remedies beneath the table.
 */
import { join } from "node:path";
import type { Options, Report } from "./contracts";
import { CLI_VERSION } from "./install/release";
import type { State } from "./install/state";

export const RESET = "\u001b[0m";
export const WOOD = "\u001b[38;2;176;132;106m";
export const BOLD = "\u001b[1m";
export const MUTED = "\u001b[2m";
export const GREEN = "\u001b[38;2;34;197;94m";
export const RED = "\u001b[38;2;239;68;68m";
export const AMBER = "\u001b[38;2;217;119;6m";

const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"] as const;
const SPINNER_INTERVAL_MS = 120;
const MAX_SUMMARY_BOX_WIDTH = 78;
const MIN_SUMMARY_BOX_WIDTH = 44;
const DEFAULT_TABLE_MAX_WIDTH = 96;
const MIN_TABLE_WIDTH = 56;
const MIN_FLEX_COLUMN_WIDTH = 14;
const BIRD_COL_WIDTH = 16;

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

export interface TableOptions {
  headers: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  decorated: boolean;
  maxWidth?: number;
  indent?: string;
  columnMinWidths?: readonly number[];
}

export interface WizardSummaryInput {
  directory: string;
  frameworks: string;
  capabilities: string;
  ports: string;
  equivalentCommand: string;
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
      while (
        index < text.length &&
        text[index] !== "m" &&
        text[index] !== "K" &&
        text[index] !== "A" &&
        text[index] !== "h" &&
        text[index] !== "l" &&
        text[index] !== "J"
      ) {
        index++;
      }
      continue;
    }
    result += text[index];
  }
  return result;
}

function padVisibleEnd(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  return text + " ".repeat(Math.max(0, width - visible));
}

function wrapPlainLine(text: string, maxWidth: number): string[] {
  const limit = Math.max(8, maxWidth);
  if (text.length <= limit) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const windowText = remaining.slice(0, limit + 1);
    const spaceSplit = windowText.lastIndexOf(" ");
    const slashSplit = windowText.lastIndexOf("/");
    let split = spaceSplit;
    if (split <= 6 && slashSplit > 6) {
      // Keep the trailing slash on the upper line so long filesystem paths stay scannable.
      split = slashSplit + 1;
    }
    if (split <= 6) split = limit;
    lines.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

function wrapCellText(text: string, width: number): string[] {
  const limit = Math.max(8, width);
  if (stripAnsi(text).length <= limit) return [text];
  return wrapPlainLine(stripAnsi(text), limit);
}

/** Renders the line-art Wrenly bird silhouette alongside name, version, and context. */
export function renderBrandHeader(
  subtitle: string,
  decorated: boolean,
): string {
  if (!decorated) {
    return `wrenly v${CLI_VERSION} · ${subtitle}\n\n`;
  }
  const wing = (stroke: string): string => `${MUTED}${WOOD}${stroke}${RESET}`;
  const body = (stroke: string): string => `${WOOD}${stroke}${RESET}`;
  const birdLines = [
    { styled: `    ${wing("⢸⢳⡀⣠⠎⡇")}   `, visibleLen: 13, info: "" },
    { styled: ` ${wing("⠸⡝⠦⡏ ⠙⠁ ⡇")}   `, visibleLen: 13, info: "" },
    {
      styled: `${wing("⡤⣄⣳")}      ${body("⡧⠤⣄⣀")}`,
      visibleLen: 13,
      info: `${BOLD}wrenly${RESET}  ${WOOD}v${CLI_VERSION}${RESET}`,
    },
    {
      styled: `${wing("⠘⢦⡀")}    ${body("⣠⡾")}${wing("⠃")}${body("⢠⠏")} `,
      visibleLen: 13,
      info: `${MUTED}Self-hosted AI app builder${RESET}`,
    },
    {
      styled: `${wing("⠶⣖⡋⠁")}  ${body("⠸⣅  ⡼")}  `,
      visibleLen: 13,
      info: `${MUTED}${subtitle}${RESET}`,
    },
    { styled: `  ${wing("⣩⠵⠂")} ${body("⣠⠏⢀⡴⠁")}  `, visibleLen: 13, info: "" },
    { styled: `  ${wing("⠈⠉⠉⠉")}${body("⡯⠖⠋")}    `, visibleLen: 13, info: "" },
  ];

  const rows = birdLines.map((row) => {
    if (!row.info) return `  ${row.styled}`;
    const gap = " ".repeat(Math.max(3, BIRD_COL_WIDTH - row.visibleLen));
    return `  ${row.styled}${gap}${row.info}`;
  });
  return `\n${rows.join("\n")}\n\n`;
}

/** Renders structured tabular data with rounded borders in interactive terminals or aligned plain columns otherwise. */
export function renderTable(options: TableOptions, columns = 80): string {
  const colCount = options.headers.length;
  if (colCount === 0) return "";
  const indent = options.indent ?? "  ";

  if (!options.decorated) {
    const plainWidths = options.headers.map((header, colIndex) => {
      const cellMax = options.rows.reduce(
        (max, row) => Math.max(max, stripAnsi(row[colIndex] ?? "").length),
        0,
      );
      return Math.max(
        stripAnsi(header).length,
        cellMax,
        options.columnMinWidths?.[colIndex] ?? 0,
      );
    });
    const out: string[] = [];
    out.push(
      `${indent}${options.headers
        .map((h, i) => stripAnsi(h).padEnd(plainWidths[i]!))
        .join("  ")
        .trimEnd()}`,
    );
    for (const row of options.rows) {
      out.push(
        `${indent}${options.headers
          .map((_, i) => stripAnsi(row[i] ?? "").padEnd(plainWidths[i]!))
          .join("  ")
          .trimEnd()}`,
      );
    }
    return `${out.join("\n")}\n`;
  }

  const targetWidth = Math.min(
    options.maxWidth ?? DEFAULT_TABLE_MAX_WIDTH,
    Math.max(MIN_TABLE_WIDTH, columns - 4),
  );
  // Each column adds 2 spaces of inner padding plus 1 separator border, plus 1 outer right border.
  const chromeWidth = indent.length + colCount * 3 + 1;
  const contentBudget = Math.max(
    colCount * MIN_FLEX_COLUMN_WIDTH,
    targetWidth - chromeWidth,
  );

  const widths = options.headers.map((header, colIndex) => {
    const cellMax = options.rows.reduce(
      (max, row) => Math.max(max, stripAnsi(row[colIndex] ?? "").length),
      0,
    );
    return Math.max(
      stripAnsi(header).length,
      cellMax,
      options.columnMinWidths?.[colIndex] ?? 0,
    );
  });

  const minFloor = widths.map((_, index) =>
    Math.max(
      stripAnsi(options.headers[index]!).length,
      index === colCount - 1 ? MIN_FLEX_COLUMN_WIDTH : 8,
    ),
  );

  let totalWidth = widths.reduce((sum, w) => sum + w, 0);
  while (totalWidth > contentBudget) {
    let targetCol = colCount - 1;
    let widestExcess = widths[targetCol]! - minFloor[targetCol]!;
    for (let index = 0; index < colCount - 1; index++) {
      const excess = widths[index]! - minFloor[index]!;
      // Shrink fixed columns only when they hold more than half the available width.
      if (widths[index]! > Math.floor(contentBudget / 2) && excess > widestExcess) {
        targetCol = index;
        widestExcess = excess;
      }
    }
    if (widestExcess <= 0) break;
    widths[targetCol] = widths[targetCol]! - 1;
    totalWidth--;
  }

  const border = (glyphs: string): string => `${MUTED}${WOOD}${glyphs}${RESET}`;
  const top = `${indent}${border("╭")}${widths
    .map((w) => border("─".repeat(w + 2)))
    .join(border("┬"))}${border("╮")}`;
  const headerLine = `${indent}${border("│")}${options.headers
    .map((header, i) => ` ${BOLD}${padVisibleEnd(header, widths[i]!)}${RESET} `)
    .join(border("│"))}${border("│")}`;
  const divider = `${indent}${border("├")}${widths
    .map((w) => border("─".repeat(w + 2)))
    .join(border("┼"))}${border("┤")}`;
  const bottom = `${indent}${border("╰")}${widths
    .map((w) => border("─".repeat(w + 2)))
    .join(border("┴"))}${border("╯")}`;

  const bodyLines: string[] = [];
  for (const row of options.rows) {
    const wrappedCells = widths.map((w, colIndex) =>
      wrapCellText(row[colIndex] ?? "", w),
    );
    const rowHeight = Math.max(
      1,
      ...wrappedCells.map((lines) => lines.length),
    );
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
      const renderedCells = widths.map(
        (w, colIndex) =>
          ` ${padVisibleEnd(wrappedCells[colIndex]![lineIndex] ?? "", w)} `,
      );
      bodyLines.push(
        `${indent}${border("│")}${renderedCells.join(border("│"))}${border("│")}`,
      );
    }
  }

  return `${[top, headerLine, divider, ...bodyLines, bottom].join("\n")}\n`;
}

/** Renders doctor prerequisite checks in a rounded table with clear pass/fail badges and remedies. */
export function renderDoctorTable(
  report: Report,
  decorated: boolean,
  columns = 80,
): string {
  const formatStatus = (status: Report["checks"][number]["status"]): string => {
    if (!decorated) return status.toUpperCase();
    if (status === "pass") return `${GREEN}✔ Pass${RESET}`;
    if (status === "failed") return `${RED}✘ Fail${RESET}`;
    return `${AMBER}▲ Warn${RESET}`;
  };

  const table = renderTable(
    {
      headers: ["Check", "Status", "Details"],
      rows: report.checks.map((check) => [
        check.name,
        formatStatus(check.status),
        check.message,
      ]),
      decorated,
    },
    columns,
  );

  const remedies = report.checks
    .filter((check) => Boolean(check.remedy))
    .map((check) =>
      decorated
        ? `  ${AMBER}▲${RESET}  ${BOLD}${check.name}:${RESET} ${MUTED}${check.remedy}${RESET}`
        : `  -> ${check.name}: ${check.remedy}`,
    );

  const passCount = report.checks.filter((check) => check.status === "pass").length;
  const summaryLine = report.ready
    ? decorated
      ? `  ${GREEN}✔${RESET}  ${BOLD}Prerequisites passed${RESET} ${MUTED}(${passCount}/${report.checks.length})${RESET}`
      : "Prerequisites passed."
    : decorated
      ? `  ${AMBER}▲${RESET}  ${BOLD}Resolve the failed or unconfirmed checks before installing.${RESET}`
      : "Resolve the failed or unconfirmed checks before installing.";

  const sections = [table.trimEnd()];
  if (remedies.length > 0) sections.push("", ...remedies);
  sections.push("", summaryLine);
  return `${sections.join("\n")}\n`;
}

/** Renders the installation component plan as a scannable table instead of a wall of prose. */
export function renderPlanTable(
  options: Options,
  decorated: boolean,
  columns = 80,
  dryRun = true,
): string {
  const badge = (
    kind: "ready" | "included" | "enabled" | "off" | "guided",
  ): string => {
    const label =
      kind === "ready"
        ? "New"
        : kind === "included"
          ? "Included"
          : kind === "enabled"
            ? "Enabled"
            : kind === "guided"
              ? "Guided"
              : "Off";
    if (!decorated) return label;
    if (kind === "enabled") return `${GREEN}${label}${RESET}`;
    if (kind === "off") return `${MUTED}${label}${RESET}`;
    return `${WOOD}${label}${RESET}`;
  };

  const rows: string[][] = [
    ["Destination", badge("ready"), options.directory],
    [
      "Core workspace",
      badge("included"),
      `Next.js 16 · Web :${options.webPort} · API :${options.apiPort}`,
    ],
    [
      "Database",
      badge("included"),
      `Dedicated PostgreSQL 16 (:${options.databasePort})`,
    ],
    [
      "Local previews",
      options.previews ? badge("enabled") : badge("off"),
      options.previews
        ? `Isolated containers (:${options.previewPort})`
        : "Add --previews on a fresh install",
    ],
    [
      "Laravel 13",
      options.laravel ? badge("enabled") : badge("off"),
      options.laravel
        ? "FrankenPHP · PHP 8.4 runtime image"
        : "Add --laravel on a fresh install",
    ],
    [
      "App databases",
      options.databases ? badge("enabled") : badge("off"),
      options.databases
        ? "Dev PostgreSQL per project (prod off)"
        : "Add --databases on a fresh install",
    ],
    [
      "Inspection MCP",
      options.inspection ? badge("enabled") : badge("off"),
      options.inspection
        ? "Laravel Boost + Next.js DevTools"
        : "Add --inspection on a fresh install",
    ],
    [
      "Voice dictation",
      options.dictation ? badge("enabled") : badge("off"),
      options.dictation
        ? "Local Whisper (~148 MB verified)"
        : "Add --dictation on a fresh install",
    ],
    ["Owner setup", badge("guided"), "First-owner credentials in browser"],
  ];

  const table = renderTable(
    {
      headers: ["Component", "Status", "Details"],
      rows,
      decorated,
    },
    columns,
  );

  if (!dryRun) return table;

  const dryRunNote = decorated
    ? `\n  ${MUTED}Dry run only — nothing was downloaded or changed. Run install to apply.${RESET}\n`
    : "\nDry run only — nothing was downloaded or changed. Run install to apply.\n";
  return `${table}${dryRunNote}`;
}

/** Renders the wizard's review table and keeps the copy-pasteable equivalent command outside box borders. */
export function renderWizardSummary(
  summary: WizardSummaryInput,
  decorated: boolean,
  columns = 80,
): string {
  const table = renderTable(
    {
      headers: ["Setting", "Selection"],
      rows: [
        ["Folder", summary.directory],
        ["Frameworks", summary.frameworks],
        ["Capabilities", summary.capabilities],
        ["Ports", summary.ports],
      ],
      decorated,
    },
    columns,
  );
  if (!decorated) {
    return `\n${table}\n  Equivalent command: ${summary.equivalentCommand}\n\n`;
  }
  return `\n${table}\n  ${MUTED}Equivalent command:${RESET}\n  ${summary.equivalentCommand}\n\n`;
}

/** Renders Forge/Artisan-style aligned command reference opened by the Wrenly bird header. */
export function renderHelp(decorated: boolean): string {
  const heading = (title: string): string =>
    decorated ? `  ${BOLD}${WOOD}${title}${RESET}` : `  ${title}`;
  const entry = (name: string, description: string, width = 26): string => {
    const padded = name.length + 3 > width ? `${name}   ` : name.padEnd(width);
    if (!decorated) return `    ${padded}${description}`;
    return `    ${WOOD}${padded}${RESET}${description}`;
  };
  const note = (text: string): string =>
    decorated ? `    ${MUTED}${text}${RESET}` : `    ${text}`;

  const lines = [
    heading("USAGE"),
    decorated
      ? `    ${BOLD}bunx @wrenly/cli${RESET} ${MUTED}[command] [options]${RESET}`
      : "    bunx @wrenly/cli [command] [options]",
    "",
    heading("COMMANDS"),
    entry("install", "Prepare a verified release, database and local services"),
    entry("doctor", "Check host prerequisites, ports and disk space"),
    entry("plan", "Preview installation components and checks without changes"),
    entry("status", "Inspect the installation journal, database and runtime"),
    entry("start", "Start the installation's PostgreSQL and local runtime"),
    entry("stop", "Stop services while preserving all data and keys"),
    entry("resume", "Continue an interrupted installation safely"),
    entry("setup", "Print a one-time owner onboarding link in the terminal"),
    entry("version", "Display the installed CLI version"),
    entry("help", "Display this command reference"),
    "",
    heading("SETUP"),
    entry("--directory <path>", "Absolute installation folder (default: <cwd>/wrenly)"),
    entry("--web-port <port>", "Browser port (default: 3000)"),
    entry("--api-port <port>", "API port (default: 3002)"),
    entry("--database-port <port>", "PostgreSQL port (default: 65433)"),
    entry("--preview-port <port>", "Preview gateway port (default: 3003)"),
    "",
    heading("CAPABILITIES"),
    entry("--preset <name>", "minimal | recommended | full"),
    entry("  minimal", "Next.js 16 core workspace only"),
    entry("  recommended", "Next.js 16 + Laravel 13, previews, app databases, inspection"),
    entry("  full", "recommended + local voice dictation"),
    entry("--previews", "Prepare isolated local preview containers"),
    entry("--laravel", "Build the Laravel 13 FrankenPHP runtime image"),
    entry("--databases", "Prepare Development app databases (enables previews)"),
    entry("--inspection", "Build official Laravel & Next.js MCP inspection images"),
    entry("--dictation", "Download Whisper weights and build dictation runtime"),
    "",
    heading("AUTOMATION"),
    entry("--archive <file>", "Use a pre-downloaded verified release tarball"),
    entry("--json", "Output structured JSON (doctor, plan, status)"),
    entry("--yes", "Confirm non-interactive execution without prompts"),
    entry("-v, --version", "Display the installed CLI version"),
    entry("-h, --help", "Display this command reference"),
    "",
    heading("EXAMPLES"),
    entry("bunx @wrenly/cli", "Interactive guided setup", 43),
    entry("bunx @wrenly/cli doctor", "Verify host prerequisites", 43),
    entry("bunx @wrenly/cli plan --preset recommended", "Preview full recommended plan", 43),
    "",
    heading("NOTES"),
    note("Running without arguments or install without --yes opens interactive prompts on a TTY."),
    note("Stop preserves data. This version does not upgrade or uninstall an instance."),
    note("Optional major updates: https://www.usewrenly.org/#join (browser only; no CLI email collection)."),
  ];

  return `${renderBrandHeader("guided local setup", decorated)}${lines.join("\n")}\n\n`;
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
  const border = (text: string): string => `${MUTED}${WOOD}${text}${RESET}`;
  const top = `${border(headerPrefix)}${border("─".repeat(headerFill))}${border("╮")}`;
  const bottom = `${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`;
  const body = lines.map((line) => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, contentWidth - visible);
    return `${border("│")} ${line}${" ".repeat(pad)} ${border("│")}`;
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
    flag?: string;
  }> = [
    { enabled: true, label: "Next.js 16 core workspace" },
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
          : `○ ${item.label} (new install with ${item.flag ?? ""})`,
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
    ["Updates", ["https://www.usewrenly.org/#join (optional updates, browser only)"]],
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
  const spacerBefore = new Set(["Included", "Next steps", "Manage", "Updates"]);
  for (const [label, values] of plainRows) {
    if (spacerBefore.has(label)) boxLines.push("");
    if (label === "Included") {
      for (const [index, cap] of capabilities.entries()) {
        const key =
          index === 0
            ? `${BOLD}${label.padEnd(labelWidth)}${RESET}`
            : " ".repeat(labelWidth);
        const icon = cap.enabled ? `${GREEN}✔${RESET}` : `${MUTED}○${RESET}`;
        const suffix =
          cap.enabled || !cap.flag
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
  return renderRoundedBox("Wrenly is ready", boxLines, columns);
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

/** Formats the cohesive owner setup rail containing the one-time link without browser auto-open noise. */
export function renderOwnerSetupLink(
  url: string,
  directory: string,
  decorated: boolean,
): string {
  const dirArg = quoteDirectoryArg(directory);
  if (!decorated) {
    return [
      "",
      "Owner account setup",
      "Open this private link within 10 minutes (one-time use; do not share):",
      url,
      "",
      `Need a fresh link later? Run: bunx @wrenly/cli setup --directory ${dirArg}`,
      "",
      "",
    ].join("\n");
  }
  return [
    "",
    `  ${WOOD}◆${RESET}  ${BOLD}Owner account setup${RESET}`,
    `  ${WOOD}│${RESET}  ${MUTED}Ctrl+Click the link below to create your first owner account.${RESET}`,
    `  ${WOOD}│${RESET}`,
    `  ${WOOD}│${RESET}  ${BOLD}${WOOD}${url}${RESET}`,
    `  ${WOOD}│${RESET}`,
    `  ${WOOD}│${RESET}  ${MUTED}One-time use · expires in 10 minutes · do not share.${RESET}`,
    `  ${WOOD}└${RESET}  ${MUTED}Need a fresh link later? Run:${RESET} bunx @wrenly/cli setup --directory ${dirArg}`,
    "",
    "",
  ].join("\n");
}

/** Formats concise completion feedback for lifecycle subcommands (`start`, `stop`, `resume`). */
export function renderActionResult(
  message: string,
  decorated: boolean,
): string {
  if (!decorated) return `${message}\n`;
  return `\n  ${GREEN}✔${RESET}  ${BOLD}${message}${RESET}\n\n`;
}

/** Decorates progress steps and known headings while passing structured output and pre-styled cards untouched. */
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
    const counter = spinner.counter
      ? `${MUTED}[${spinner.counter}]${RESET} `
      : "";
    write(
      `\r\u001b[2K  ${WOOD}${frame}${RESET}  ${counter}${BOLD}${spinner.label}${RESET}`,
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
            `  ${GREEN}✔${RESET}  ${BOLD}${label}${RESET}  ${MUTED}${elapsed}${RESET}`,
          );
        } else {
          clearSpinner(true);
          out.push(`  ${GREEN}✔${RESET}  ${BOLD}${line}${RESET}`);
        }
        if (!hasNewline) {
          write(out.join("\n"));
          out.length = 0;
        }
        continue;
      }

      if (spinner && line.length > 0) clearSpinner(true);

      if (line.startsWith("Downloading verified Wrenly source")) {
        out.push(`\n  ${WOOD}↓${RESET}  ${MUTED}${line}${RESET}\n`);
      } else if (
        line.includes(" did not complete.") ||
        line.startsWith("Setup could not be completed") ||
        line.startsWith("Cancelled.")
      ) {
        out.push(`\n  ${RED}✘${RESET}  ${line}\n`);
      } else {
        out.push(line);
      }
    }
    if (out.length > 0) write(out.join("\n"));
  };
}
