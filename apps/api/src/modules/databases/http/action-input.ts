// Counts actual streamed bytes after authentication/origin checks. Reading input
// never saves work; cancellation/deadline failures must stop before admission.
export const DATABASE_ACTION_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 5000;
export class DatabaseActionInputError extends Error {
  constructor(public readonly status: 400 | 408 | 413 | 415) {
    super("Review the database action and send a small JSON request.");
    this.name = "DatabaseActionInputError";
  }
}
/** Reads untrusted JSON under byte/time/cancellation bounds; caller still validates the action schema. */
export async function readDatabaseActionInput(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new DatabaseActionInputError(415);
  const reader = request.body?.getReader();
  if (!reader) throw new DatabaseActionInputError(400);
  let expired = false;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  const timer = setTimeout(() => { expired = true; cancel(); }, BODY_TIMEOUT_MS);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    request.signal.throwIfAborted();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read();
      request.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > DATABASE_ACTION_BODY_BYTES) throw new DatabaseActionInputError(413);
      chunks.push(part.value);
    }
    if (expired) throw new DatabaseActionInputError(408);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new DatabaseActionInputError(400); }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
