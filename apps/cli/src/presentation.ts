/** Terminal decoration never changes the underlying messages, JSON or execution decisions. */
const RESET = "\u001b[0m";
const WOOD = "\u001b[38;2;151;112;85m";
const BOLD = "\u001b[1m";
const MUTED = "\u001b[2m";
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
          if (line.startsWith("Wrenly ·"))
            return `${BOLD}${WOOD}${line}${RESET}`;
          const check = /^(PASS|FAILED|UNCONFIRMED)( {2}.*)$/.exec(line);
          if (check) return `${BOLD}${WOOD}${check[1]}${RESET}${check[2]}`;
          if (line.startsWith("Preparing ")) return `${WOOD}${line}${RESET}`;
          if (line.endsWith(" ready.")) return `${BOLD}${line}${RESET}`;
          if (line.startsWith("Destination:") || line.startsWith("Browser:"))
            return `${MUTED}${line}${RESET}`;
          return line;
        })
        .join("\n"),
    );
}
