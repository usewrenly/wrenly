/**
 * Formatting bounded prior source as model context.
 * Existing Next.js/Laravel edits use the full structured editing contract instead; this formatter supports context for other applicable generation requests.
 * It does not merge files or authorize incomplete-context editing.
 */
const PREVIOUS_FILES_MAX_CHARS = 40_000;
const PREVIOUS_FILE_MAX_CHARS = 8_000;

/** Formats bounded prior source context for generation and repair requests. */
export function buildPreviousFilesContext(files: unknown): string {
  if (!Array.isArray(files) || files.length === 0) return "";

  const entries = files.filter(
    (f): f is { path: string; content: string } =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as { path?: unknown }).path === "string" &&
      typeof (f as { content?: unknown }).content === "string",
  );
  if (entries.length === 0) return "";

  let block =
    "Previous build files (modify these in place, keep unrelated files):\n\n";
  let budget = PREVIOUS_FILES_MAX_CHARS;

  for (const file of entries) {
    let body = file.content;
    if (body.length > PREVIOUS_FILE_MAX_CHARS) {
      body = `${body.slice(0, PREVIOUS_FILE_MAX_CHARS)}\n…(truncated)`;
    }
    const chunk = `--- ${file.path} ---\n${body}\n\n`;
    if (chunk.length > budget) {
      block += `…(remaining files omitted — full list: ${entries.map((e) => e.path).join(", ")})\n`;
      break;
    }
    block += chunk;
    budget -= chunk.length;
  }

  return block;
}
