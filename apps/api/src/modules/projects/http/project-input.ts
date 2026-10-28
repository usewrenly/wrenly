/**
 * Bounded JSON reading for project creation after session verification.
 * Counts actual streamed bytes rather than trusting Content-Length. The small
 * metadata contract needs no source files; limits stop oversized or stalled uploads
 * before persistence is reached.
 */
const MAX_BODY_BYTES = 8 * 1024;
const BODY_TIMEOUT_MS = 5_000;

export class ProjectInputError extends Error {
  constructor(
    public readonly status: 400 | 408 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "ProjectInputError";
  }
}

/** Returns untrusted parsed JSON; the caller still validates the project schema. */
export async function readProjectInput(request: Request): Promise<unknown> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ProjectInputError(415, "Send project details as JSON.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new ProjectInputError(400, "Project details are required.");
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, BODY_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES)
        throw new ProjectInputError(413, "Project details are too large.");
      chunks.push(chunk.value);
    }
    if (expired)
      throw new ProjectInputError(408, "Reading project details timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ProjectInputError(400, "Project details must be valid JSON.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
