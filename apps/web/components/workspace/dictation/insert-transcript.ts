/** Pure helper for inserting dictated speech cleanly into an existing composer draft. */
export const MAX_PROMPT_CHARS = 16_000;

export interface TextSelectionRange {
  start: number;
  end: number;
}

/**
 * Inserts validated speech into `current` at `selection` with smart spacing, or appends on a new line
 * when no valid cursor range applies. Returns `null` if the transcript is empty or exceeds `MAX_PROMPT_CHARS`.
 */
export function insertTranscriptText(
  current: string,
  transcript: string,
  selection?: TextSelectionRange | null,
): { text: string; caret: number } | null {
  const clean = transcript.trim();
  if (!clean) return null;

  if (
    selection &&
    current.length > 0 &&
    Number.isInteger(selection.start) &&
    Number.isInteger(selection.end) &&
    selection.start >= 0 &&
    selection.end >= selection.start &&
    selection.end <= current.length
  ) {
    const before = current.slice(0, selection.start);
    const after = current.slice(selection.end);
    const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const trailing = after.length > 0 && !/^\s/.test(after) ? " " : "";
    const combinedPrefix = `${before}${leading}${clean}`;
    const text = `${combinedPrefix}${trailing}${after}`;
    if (text.length > MAX_PROMPT_CHARS) return null;
    return { text, caret: combinedPrefix.length };
  }

  const text = current.trim() ? `${current}\n${clean}` : clean;
  if (text.length > MAX_PROMPT_CHARS) return null;
  return { text, caret: text.length };
}
