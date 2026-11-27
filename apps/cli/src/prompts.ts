/** Dependency-free inline terminal prompts matching the installer guide-rail aesthetic. */
import { AMBER, BOLD, MUTED, RED, RESET, WOOD, stripAnsi } from "./presentation";

export interface PromptIO {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
    pause?: () => void;
  };
  output: {
    write(text: string): void;
    columns?: number;
  };
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

/** Raised when the operator cancels an interactive prompt via Ctrl+C, Esc, or negative confirmation. */
export class PromptCancelledError extends Error {
  constructor(message = "Cancelled. Nothing was installed.") {
    super(message);
    this.name = "PromptCancelledError";
  }
}

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_LEFT = "\u001b[D";
const ALT_UP = "\u001bOA";
const ALT_DOWN = "\u001bOB";
const ALT_RIGHT = "\u001bOC";
const ALT_LEFT = "\u001bOD";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const DEFAULT_COLUMNS = 80;

function countWrappedLines(lines: string[], columns: number): number {
  const width = Math.max(20, columns);
  let total = 0;
  for (const line of lines) {
    const visible = stripAnsi(line).length;
    total += Math.max(1, Math.ceil(visible / width));
  }
  return total;
}

function rail(decorated: boolean): string {
  return decorated ? `  ${WOOD}│${RESET}` : "  │";
}

function diamondActive(decorated: boolean): string {
  return decorated ? `  ${WOOD}◆${RESET}` : "  ◆";
}

function diamondDone(decorated: boolean): string {
  return decorated ? `  ${WOOD}◇${RESET}` : "  ◇";
}

function cornerBottom(decorated: boolean): string {
  return decorated ? `  ${WOOD}└${RESET}` : "  └";
}

function cancelMark(decorated: boolean): string {
  return decorated ? `  ${RED}■${RESET}` : "  ■";
}

function bold(text: string, decorated: boolean): string {
  return decorated ? `${BOLD}${text}${RESET}` : text;
}

function muted(text: string, decorated: boolean): string {
  return decorated ? `${MUTED}${text}${RESET}` : text;
}

function amber(text: string, decorated: boolean): string {
  return decorated ? `${AMBER}${text}${RESET}` : text;
}

function parseTokens(chunk: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < chunk.length; ) {
    if (chunk[index] === "\u001b") {
      const three = chunk.slice(index, index + 3);
      if (
        [
          KEY_UP,
          KEY_DOWN,
          KEY_RIGHT,
          KEY_LEFT,
          ALT_UP,
          ALT_DOWN,
          ALT_RIGHT,
          ALT_LEFT,
        ].includes(three)
      ) {
        tokens.push(three);
        index += 3;
        continue;
      }
      if (chunk[index + 1] === "[") {
        // Consume unrecognized CSI sequences safely so stray escape bytes never print.
        let end = index + 2;
        while (
          end < chunk.length &&
          chunk.charCodeAt(end) >= 0x20 &&
          chunk.charCodeAt(end) <= 0x3f
        ) {
          end++;
        }
        if (end < chunk.length) end++;
        index = end;
        continue;
      }
      tokens.push("\u001b");
      index += 1;
      continue;
    }
    tokens.push(chunk[index]!);
    index += 1;
  }
  return tokens;
}

async function runInteractivePrompt<T>(
  io: PromptIO,
  decorated: boolean,
  message: string,
  renderActive: () => string[],
  handleToken: (
    token: string,
  ) =>
    | { type: "redraw" }
    | { type: "submit"; value: T; summary: string }
    | { type: "cancel" }
    | Promise<
        | { type: "redraw" }
        | { type: "submit"; value: T; summary: string }
        | { type: "cancel" }
      >,
): Promise<T> {
  const columns = io.output.columns ?? DEFAULT_COLUMNS;
  let renderedRows = 0;

  const drawFrame = (lines: string[]): void => {
    if (renderedRows > 0) {
      io.output.write(`\u001b[${renderedRows}A\r\u001b[J`);
    }
    io.output.write(`${lines.join("\n")}\n`);
    renderedRows = countWrappedLines(lines, columns);
  };

  const clearFrame = (): void => {
    if (renderedRows > 0) {
      io.output.write(`\u001b[${renderedRows}A\r\u001b[J`);
      renderedRows = 0;
    }
  };

  const canSetRawMode = typeof io.input.setRawMode === "function";
  if (canSetRawMode) io.input.setRawMode!(true);
  io.input.resume?.();
  io.output.write(HIDE_CURSOR);

  try {
    drawFrame(renderActive());
    return await new Promise<T>((resolve, reject) => {
      let chain = Promise.resolve();
      let settled = false;

      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        io.input.removeListener("data", onData);
        io.input.removeListener("end", onEnd);
        io.input.removeListener("close", onEnd);
        outcome();
      };

      const onEnd = (): void => {
        finish(() => {
          clearFrame();
          io.output.write(
            `${cancelMark(decorated)}  ${bold(message, decorated)}\n${rail(decorated)}  ${muted("Cancelled", decorated)}\n`,
          );
          reject(new PromptCancelledError());
        });
      };

      const onData = (raw: Buffer | string): void => {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        for (const token of parseTokens(text)) {
          if (token === "\u0003" || token === "\u001b") {
            finish(() => {
              clearFrame();
              io.output.write(
                `${cancelMark(decorated)}  ${bold(message, decorated)}\n${rail(decorated)}  ${muted("Cancelled", decorated)}\n`,
              );
              reject(new PromptCancelledError());
            });
            return;
          }
          chain = chain.then(async () => {
            if (settled) return;
            const action = await handleToken(token);
            if (action.type === "redraw") {
              drawFrame(renderActive());
            } else if (action.type === "submit") {
              finish(() => {
                clearFrame();
                io.output.write(
                  `${diamondDone(decorated)}  ${bold(message, decorated)}\n${rail(decorated)}  ${muted(action.summary, decorated)}\n${rail(decorated)}\n`,
                );
                resolve(action.value);
              });
            } else {
              onEnd();
            }
          });
        }
      };

      io.input.on("data", onData);
      io.input.once("end", onEnd);
      io.input.once("close", onEnd);
    });
  } finally {
    io.input.pause?.();
    if (canSetRawMode) io.input.setRawMode!(false);
    io.output.write(SHOW_CURSOR);
  }
}

/** Collects a single-line string value with inline validation and backspace editing. */
export async function textPrompt(
  options: {
    message: string;
    initial?: string;
    placeholder?: string;
    hint?: string;
    validate?: (value: string) => string | undefined | Promise<string | undefined>;
  },
  io: PromptIO,
  decorated = true,
): Promise<string> {
  let buffer = options.placeholder !== undefined ? "" : (options.initial ?? "");
  let touched = options.placeholder === undefined;
  let errorText: string | undefined;
  const cursorMark = decorated ? `${WOOD}▌${RESET}` : "▌";

  return runInteractivePrompt<string>(
    io,
    decorated,
    options.message,
    () => {
      const displayValue =
        options.placeholder !== undefined && !touched
          ? `${cursorMark}${muted(options.placeholder, decorated)}`
          : `${buffer}${cursorMark}`;
      const hintText =
        options.hint ??
        (options.placeholder !== undefined && !touched
          ? "type a value or press enter for default · ctrl+c cancel"
          : "enter confirm · ctrl+c cancel");
      const lines = [
        `${diamondActive(decorated)}  ${bold(options.message, decorated)}`,
        `${rail(decorated)}  ${displayValue}`,
      ];
      if (errorText) lines.push(`${rail(decorated)}  ${amber(errorText, decorated)}`);
      lines.push(`${cornerBottom(decorated)}  ${muted(hintText, decorated)}`);
      return lines;
    },
    async (token) => {
      if (token === "\r" || token === "\n") {
        const submitted =
          options.placeholder !== undefined && !touched
            ? options.placeholder
            : buffer;
        const error = options.validate
          ? await options.validate(submitted)
          : undefined;
        if (error) {
          errorText = error;
          return { type: "redraw" };
        }
        return { type: "submit", value: submitted, summary: submitted };
      }
      if (token === "\u007f" || token === "\b") {
        if (options.placeholder !== undefined && !touched) {
          touched = true;
          buffer = options.placeholder.slice(0, -1);
        } else {
          buffer = buffer.slice(0, -1);
        }
        errorText = undefined;
        return { type: "redraw" };
      }
      if (
        token.length === 1 &&
        token.charCodeAt(0) >= 32 &&
        token.charCodeAt(0) !== 127
      ) {
        if (options.placeholder !== undefined && !touched) {
          touched = true;
          buffer = token;
        } else {
          buffer += token;
        }
        errorText = undefined;
        return { type: "redraw" };
      }
      return { type: "redraw" };
    },
  );
}

/** Prompts for a boolean confirmation using left/right arrows or y/n keys. */
export async function confirmPrompt(
  options: { message: string; initial?: boolean },
  io: PromptIO,
  decorated = true,
): Promise<boolean> {
  let value = options.initial ?? true;

  return runInteractivePrompt<boolean>(
    io,
    decorated,
    options.message,
    () => {
      const yesPill = value
        ? bold(`${decorated ? WOOD : ""}● Yes${decorated ? RESET : ""}`, decorated)
        : muted("○ Yes", decorated);
      const noPill = !value
        ? bold(`${decorated ? WOOD : ""}● No${decorated ? RESET : ""}`, decorated)
        : muted("○ No", decorated);
      return [
        `${diamondActive(decorated)}  ${bold(options.message, decorated)}`,
        `${rail(decorated)}  ${yesPill}   ${noPill}`,
        `${cornerBottom(decorated)}  ${muted("←/→ or y/n toggle · enter confirm", decorated)}`,
      ];
    },
    (token) => {
      if (token === "\r" || token === "\n") {
        return { type: "submit", value, summary: value ? "Yes" : "No" };
      }
      if (
        token === KEY_LEFT ||
        token === KEY_RIGHT ||
        token === ALT_LEFT ||
        token === ALT_RIGHT
      ) {
        value = !value;
        return { type: "redraw" };
      }
      if (token.toLowerCase() === "y") {
        value = true;
        return { type: "submit", value: true, summary: "Yes" };
      }
      if (token.toLowerCase() === "n") {
        value = false;
        return { type: "submit", value: false, summary: "No" };
      }
      return { type: "redraw" };
    },
  );
}

/** Selects one option from a vertical list using arrow or j/k keys. */
export async function selectPrompt<T extends string>(
  options: {
    message: string;
    options: readonly SelectOption<T>[];
    initial?: T;
  },
  io: PromptIO,
  decorated = true,
): Promise<T> {
  if (options.options.length === 0) {
    throw new Error("Select prompt requires at least one option.");
  }
  let cursor = Math.max(
    0,
    options.options.findIndex((option) => option.value === options.initial),
  );

  return runInteractivePrompt<T>(
    io,
    decorated,
    options.message,
    () => {
      const items = options.options.map((option, index) => {
        const active = index === cursor;
        const marker = active
          ? `${decorated ? WOOD : ""}●${decorated ? RESET : ""}`
          : muted("○", decorated);
        const label = active ? bold(option.label, decorated) : option.label;
        const hint = option.hint ? `  ${muted(option.hint, decorated)}` : "";
        return `${rail(decorated)}  ${marker} ${label}${hint}`;
      });
      return [
        `${diamondActive(decorated)}  ${bold(options.message, decorated)}`,
        ...items,
        `${cornerBottom(decorated)}  ${muted("↑/↓ move · enter confirm", decorated)}`,
      ];
    },
    (token) => {
      if (token === "\r" || token === "\n") {
        const chosen = options.options[cursor]!;
        return { type: "submit", value: chosen.value, summary: chosen.label };
      }
      if (token === KEY_UP || token === ALT_UP || token === "k") {
        cursor = (cursor - 1 + options.options.length) % options.options.length;
        return { type: "redraw" };
      }
      if (token === KEY_DOWN || token === ALT_DOWN || token === "j") {
        cursor = (cursor + 1) % options.options.length;
        return { type: "redraw" };
      }
      return { type: "redraw" };
    },
  );
}

/** Selects zero or more options using space to toggle and 'a' to toggle all. */
export async function multiselectPrompt<T extends string>(
  options: {
    message: string;
    options: readonly SelectOption<T>[];
    initial?: readonly T[];
    required?: boolean;
  },
  io: PromptIO,
  decorated = true,
): Promise<T[]> {
  if (options.options.length === 0) {
    throw new Error("Multiselect prompt requires at least one option.");
  }
  let cursor = 0;
  const selected = new Set<T>(options.initial ?? []);
  let errorText: string | undefined;

  return runInteractivePrompt<T[]>(
    io,
    decorated,
    options.message,
    () => {
      const items = options.options.map((option, index) => {
        const active = index === cursor;
        const checked = selected.has(option.value);
        const box = checked
          ? `${decorated ? WOOD : ""}[✔]${decorated ? RESET : ""}`
          : muted("[ ]", decorated);
        const pointer = active ? `${decorated ? WOOD : ""}›${decorated ? RESET : ""}` : " ";
        const label = active ? bold(option.label, decorated) : option.label;
        const hint = option.hint ? `  ${muted(option.hint, decorated)}` : "";
        return `${rail(decorated)}  ${pointer} ${box} ${label}${hint}`;
      });
      const lines = [
        `${diamondActive(decorated)}  ${bold(options.message, decorated)}`,
        ...items,
      ];
      if (errorText) lines.push(`${rail(decorated)}  ${amber(errorText, decorated)}`);
      lines.push(
        `${cornerBottom(decorated)}  ${muted("↑/↓ move · space select · a all · enter confirm", decorated)}`,
      );
      return lines;
    },
    (token) => {
      if (token === "\r" || token === "\n") {
        if (options.required && selected.size === 0) {
          errorText = "Select at least one option.";
          return { type: "redraw" };
        }
        const values = options.options
          .filter((option) => selected.has(option.value))
          .map((option) => option.value);
        const summary =
          values.length > 0
            ? options.options
                .filter((option) => selected.has(option.value))
                .map((option) => option.label)
                .join(", ")
            : "None";
        return { type: "submit", value: values, summary };
      }
      if (token === KEY_UP || token === ALT_UP || token === "k") {
        cursor = (cursor - 1 + options.options.length) % options.options.length;
        return { type: "redraw" };
      }
      if (token === KEY_DOWN || token === ALT_DOWN || token === "j") {
        cursor = (cursor + 1) % options.options.length;
        return { type: "redraw" };
      }
      if (token === " ") {
        const item = options.options[cursor]!.value;
        if (selected.has(item)) selected.delete(item);
        else selected.add(item);
        errorText = undefined;
        return { type: "redraw" };
      }
      if (token.toLowerCase() === "a") {
        const allSelected = options.options.every((option) =>
          selected.has(option.value),
        );
        selected.clear();
        if (!allSelected) {
          for (const option of options.options) selected.add(option.value);
        }
        errorText = undefined;
        return { type: "redraw" };
      }
      return { type: "redraw" };
    },
  );
}
