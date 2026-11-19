/** Terminal decoration never changes the underlying messages, JSON or execution decisions. */
const RESET = "\u001b[0m";
const WOOD = "\u001b[38;2;176;132;106m";
const BOLD = "\u001b[1m";
const MUTED = "\u001b[2m";
const PASS_PILL = "\u001b[48;2;22;101;52m\u001b[38;2;240;253;244m\u001b[1m PASS \u001b[0m";
const FAIL_PILL = "\u001b[48;2;153;27;27m\u001b[38;2;254;242;242m\u001b[1m FAIL \u001b[0m";
const WARN_PILL = "\u001b[48;2;146;64;14m\u001b[38;2;254;252;232m\u001b[1m WARN \u001b[0m";
const AMBER = "\u001b[38;2;217;119;6m";
export interface TerminalPreferences {
  interactive: boolean;
  noColor: string | undefined;
  term: string | undefined;
  ci: string | undefined;
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
function banner(title: string): string {
  const inner = `  ${title}  `;
  const width = Math.max(52, inner.length + 2);
  const top = `┌─ wrenly ${"─".repeat(Math.max(2, width - 9))}┐`;
  const mid = `│${inner.padEnd(width)}│`;
  const bot = `└${"─".repeat(width)}┘`;
  return `\n${WOOD}  ${top}${RESET}\n${BOLD}${WOOD}  ${mid}${RESET}\n${WOOD}  ${bot}${RESET}`;
}
/** Decorate only known headings/labels; private setup links and structured output pass through unchanged. */
export function createTerminalWriter(
  write: (text: string) => void,
  decorated: boolean,
): (text: string) => void {
  if (!decorated) return write;
  return (text) =>
    write(
      text
        .split("\n")
        .map((line) => {
          if (line.startsWith("Wrenly ·")) return banner(line);
          if (
            [
              "  USAGE",
              "  COMMANDS",
              "  OPTIONS",
              "  NOTES",
              "INSTALLATION PLAN",
            ].includes(line)
          )
            return `  ${BOLD}${WOOD}${line.trim()}${RESET}`;
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
            return `  ${pill}  ${BOLD}${check[2]}${RESET} ${MUTED}${check[3]}${RESET} ${check[4]}`;
          }
          if (line.startsWith("  ↳ "))
            return `         ${AMBER}↳${RESET} ${MUTED}${line.slice(4)}${RESET}`;
          if (line.startsWith("  • "))
            return `  ${WOOD}│  ◆${RESET} ${line.slice(4)}`;
          if (line === "Prerequisites passed.")
            return `  ${PASS_PILL}  ${BOLD}${line}${RESET}`;
          if (line === "Resolve the failed or unconfirmed checks before installing.")
            return `  ${WARN_PILL}  ${BOLD}${line}${RESET}`;
          if (line.startsWith("Preparing "))
            return `\n  ${WOOD}◇${RESET} ${BOLD}${line}${RESET}`;
          if (line.endsWith(" ready."))
            return `  ${PASS_PILL}  ${BOLD}${line}${RESET}`;
          if (line.startsWith("Destination:") || line.startsWith("Browser:"))
            return `  ${MUTED}${line}${RESET}`;
          return line;
        })
        .join("\n"),
    );
}
