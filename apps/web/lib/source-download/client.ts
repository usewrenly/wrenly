// Reauthorizes exact saved source; never falls back to cached or latest files.
import { parseDurableSnapshot } from "../builds/durable-build-client";
import { createSourceZip } from "./zip";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const TERMINAL_OUTCOMES = new Set([
  "success",
  "failed",
  "interrupted",
  "cancelled",
]);
const BUILD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type FetchApi = (
  path: `/api/${string}`,
  options?: RequestInit,
) => Promise<Response>;
/** Reads only the authorized build endpoint; rejects running, substituted and oversized snapshots. */
export async function loadSourceDownload(
  buildId: string,
  fetchApi: FetchApi,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (!BUILD_ID.test(buildId))
      throw new Error("Select a saved revision to download.");
    const response = await fetchApi(`/api/builds/${buildId}`, {
      signal,
      cache: "no-store",
    });
    if (response.status === 401)
      throw new Error("Sign in again before downloading source.");
    if (response.status === 404 || response.status === 403)
      throw new Error("This revision is no longer available to your account.");
    if (!response.ok || !response.body)
      throw new Error("Source could not be loaded. Try again.");
    const reader = response.body.getReader();
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES)
          throw new Error(
            "This revision is too large to download in the browser.",
          );
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    signal.throwIfAborted();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(
        "The saved source response could not be read. Try again.",
      );
    }
    const snapshot = parseDurableSnapshot(value);
    if (snapshot.build.id !== buildId)
      throw new Error(
        "The returned source does not match the selected revision.",
      );
    if (
      snapshot.outcome !== null
        ? !TERMINAL_OUTCOMES.has(snapshot.outcome)
        : !["success", "failed"].includes(snapshot.build.status)
    )
      throw new Error(
        "Wait for this revision to finish before downloading source.",
      );
    if (!snapshot.build.files?.length)
      throw new Error("This revision has no saved source files.");
    return createSourceZip(snapshot.build.files);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error("Source download could not be prepared.");
  }
}
