/** Recording uploads never reach conversation/build admission or the app-building model. */
import {
  AudioValidationError,
  DICTATION_LIMITS,
  validateDictationWav,
  hasDictationSignal,
  validateTranscript,
} from "@wrenly/audio";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { TranscriptionError, type TranscriptionAdapter } from "./contracts";
const UPLOAD_TIMEOUT_MS = 10_000;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export interface TranscriptionHttpDependencies {
  webUrl: string;
  userId(headers: Headers): Promise<string | null>;
  adapter: TranscriptionAdapter;
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: RESPONSE_HEADERS });
}
async function readAudio(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) ||
      Number(declared) > DICTATION_LIMITS.maximumUploadBytes)
  )
    throw new TranscriptionError(413, "Recordings are limited to two MiB.");
  if (!request.body)
    throw new TranscriptionError(400, "Record some speech first.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, UPLOAD_TIMEOUT_MS);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (request.signal.aborted)
      throw new TranscriptionError(400, "Recording cancelled.");
    while (true) {
      const next = await reader.read();
      if (timedOut)
        throw new TranscriptionError(
          504,
          "The recording upload timed out. Record again when the connection is ready.",
        );
      if (request.signal.aborted)
        throw new TranscriptionError(400, "Recording cancelled.");
      if (next.done) break;
      length += next.value.byteLength;
      if (length > DICTATION_LIMITS.maximumUploadBytes)
        throw new TranscriptionError(413, "Recordings are limited to two MiB.");
      chunks.push(next.value);
    }
    const audio = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    return audio;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Creates one process-local admission gate; deployments with several API replicas multiply capacity. */
export function createTranscriptionHttpHandlers(
  dependencies: TranscriptionHttpDependencies,
): {
  capability(request: Request): Promise<Response>;
  transcribe(request: Request): Promise<Response>;
} {
  const origin = new URL(dependencies.webUrl).origin;
  let active = false;
  return {
    async capability(request) {
      try {
        if (!(await dependencies.userId(request.headers)))
          return json({ error: "Sign in to use dictation." }, 401);
        return json({
          available: dependencies.adapter.available(),
          maximumSeconds: DICTATION_LIMITS.maximumSeconds,
        });
      } catch {
        return json(
          { error: "Dictation availability could not be checked." },
          503,
        );
      }
    },
    async transcribe(request) {
      let ownsSlot = false;
      try {
        if (request.headers.get("origin") !== origin)
          return json({ error: "Use Wrenly to transcribe a recording." }, 403);
        const actor = await dependencies.userId(request.headers);
        if (!actor) return json({ error: "Sign in to use dictation." }, 401);
        if (!dependencies.adapter.available())
          return json(
            { error: "Dictation is not configured on this instance." },
            503,
          );
        const identity = z
          .string()
          .uuid()
          .safeParse(request.headers.get("idempotency-key"));
        if (!identity.success)
          return json({ error: "Provide a recording request identity." }, 400);
        if (active)
          return json(
            {
              error:
                "Another recording is being transcribed. Try again shortly.",
            },
            429,
          );
        active = true;
        ownsSlot = true;
        const audio = await readAudio(request);
        validateDictationWav(audio);
        if (!hasDictationSignal(audio))
          throw new AudioValidationError(
            "No audible speech was captured. Try recording again closer to your microphone.",
          );
        const text = validateTranscript(
          await dependencies.adapter.transcribe({
            audio,
            requestId: identity.data,
            signal: request.signal,
          }),
        );
        if (request.signal.aborted)
          return json({ error: "Recording cancelled." }, 400);
        if ((await dependencies.userId(request.headers)) !== actor)
          return json({ error: "Sign in again before recording." }, 401);
        return json({ text });
      } catch (error) {
        if (error instanceof AudioValidationError)
          return json({ error: error.message }, 400);
        if (error instanceof TranscriptionError)
          return json({ error: error.message }, error.status);
        if (error instanceof Error && error.name === "TimeoutError")
          return json(
            { error: "Transcription timed out. Try a shorter recording." },
            504,
          );
        logger.error("Transcription request failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return json(
          {
            error:
              "The recording could not be transcribed. Your typed prompt is unchanged.",
          },
          503,
        );
      } finally {
        if (ownsSlot) active = false;
      }
    },
  };
}
