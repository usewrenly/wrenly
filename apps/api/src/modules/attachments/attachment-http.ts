/** Authenticated binary uploads stay separate from prompt submission and never call a model. */
import { z } from "zod";
import {
  ATTACHMENT_LIMITS,
  AttachmentPolicyError,
  decodeAttachmentText,
  type AttachmentReference,
} from "@wrenly/inference";
import { AttachmentStoreError } from "./attachment-error";
import { readAttachmentBytes } from "./images/stream";
import { MAX_CANONICAL_IMAGE_BYTES } from "./images/limits";
import type { AttachmentObjectStore } from "./storage/object-store";
import { logger } from "../../lib/logger";

const READ_TIMEOUT_MS = 5000;
const UploadQuery = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((name) =>
      Array.from(name).every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    ),
  requestId: z.string().uuid(),
});
const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export interface AttachmentHttpDependencies {
  webUrl: string;
  userId(headers: Headers): Promise<string | null>;
  objects: AttachmentObjectStore;
  decodeImage(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  save(
    actorId: string,
    input: {
      requestId: string;
      name: string;
      mediaType: AttachmentReference["mediaType"];
      object: { id: string; sha256: string; byteLength: number };
    },
  ): Promise<{ file: AttachmentReference; replayed: boolean }>;
  read(actorId: string, id: string): Promise<AttachmentReference>;
  remove(actorId: string, id: string): Promise<void>;
}
export interface AttachmentHttpHandlers {
  upload(request: Request): Promise<Response>;
  read(request: Request, id: string): Promise<Response>;
  remove(request: Request, id: string): Promise<Response>;
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}
function visible(
  file: AttachmentReference,
): Omit<AttachmentReference, "objectId"> {
  const { objectId: _objectId, ...metadata } = file;
  return metadata;
}
function failure(error: unknown): Response {
  if (error instanceof AttachmentStoreError)
    return json({ error: error.message }, error.status);
  if (error instanceof AttachmentPolicyError)
    return json({ error: error.message }, 400);
  logger.error("Attachment HTTP operation failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return json(
    {
      error:
        "Attachment state could not be confirmed. Check the saved upload before retrying.",
    },
    503,
  );
}
async function boundedBody(
  request: Request,
  ceiling: number,
): Promise<Uint8Array> {
  if (!request.body) throw new AttachmentPolicyError("Choose a nonempty file.");
  const reader = request.body.getReader();
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  });
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, READ_TIMEOUT_MS);
  request.signal.addEventListener("abort", cancel, { once: true });

  try {
    if (request.signal.aborted)
      throw new AttachmentPolicyError("Upload cancelled.");
    const bytes = await readAttachmentBytes(bounded, ceiling);
    if (timedOut || request.signal.aborted)
      throw new AttachmentPolicyError("Upload cancelled or timed out.");
    return bytes;
  } catch (error) {
    if (error instanceof AttachmentPolicyError) throw error;
    throw new AttachmentPolicyError(
      "The file is empty, too large or could not be read.",
    );
  } finally {
    clearTimeout(timer);

    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Injected services keep authorization and uncertain persistence testable without a live instance. */
export function createAttachmentHttpHandlers(
  dependencies: AttachmentHttpDependencies,
): AttachmentHttpHandlers {
  const origin = new URL(dependencies.webUrl).origin;
  const authorized = async (
    request: Request,
    mutation: boolean,
  ): Promise<string | Response> => {
    if (mutation && request.headers.get("origin") !== origin)
      return json(
        { error: "Use the Wrenly application to change attachments." },
        403,
      );
    const actor = await dependencies.userId(request.headers);
    return actor ?? json({ error: "Sign in to use attachments." }, 401);
  };
  return {
    async upload(request) {
      try {
        const actor = await authorized(request, true);
        if (actor instanceof Response) return actor;
        const url = new URL(request.url);
        const parsed = UploadQuery.safeParse({
          name: url.searchParams.get("name"),
          requestId: request.headers.get("idempotency-key"),
        });
        if (!parsed.success)
          return json(
            { error: "Provide a filename and UUID upload identity." },
            400,
          );
        const name = parsed.data.name;
        const isText = /\.(txt|md)$/i.test(name);
        if (!isText && !/\.(jpe?g|png|webp)$/i.test(name))
          return json(
            { error: "Attach JPEG, PNG, WebP, TXT or Markdown files." },
            400,
          );
        const bytes = await boundedBody(
          request,
          isText ? ATTACHMENT_LIMITS.textBytes : ATTACHMENT_LIMITS.imageBytes,
        );
        const mediaType = isText
          ? /\.md$/i.test(name)
            ? "text/markdown"
            : "text/plain"
          : "image/webp";
        const canonical = isText
          ? new TextEncoder().encode(decodeAttachmentText(bytes))
          : await dependencies.decodeImage(bytes, request.signal);
        if (canonical.length > MAX_CANONICAL_IMAGE_BYTES)
          throw new AttachmentPolicyError("The processed file is too large.");
        const object = await dependencies.objects.write(canonical);
        // A failed save can have committed remotely. Preserve bytes for reconciliation instead of deleting blindly.
        const result = await dependencies.save(actor, {
          requestId: parsed.data.requestId,
          name,
          mediaType,
          object,
        });
        if (result.replayed && result.file.objectId !== object.id)
          await dependencies.objects.remove(object.id);
        return json(
          { file: visible(result.file), replayed: result.replayed },
          result.replayed ? 200 : 201,
        );
      } catch (error) {
        return failure(error);
      }
    },
    async read(request, id) {
      try {
        const actor = await authorized(request, false);
        if (actor instanceof Response) return actor;
        const file = await dependencies.read(actor, id);
        const bytes = await dependencies.objects.read({
          id: file.objectId,
          sha256: file.sha256,
          byteLength: file.byteLength,
        });
        // Recheck after filesystem access in case project membership was revoked while bytes were read.
        await dependencies.read(actor, id);
        return new Response(Buffer.from(bytes), {
          headers: {
            ...PRIVATE_HEADERS,
            "Content-Type": file.mediaType,
            "Content-Disposition": "inline",
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
    async remove(request, id) {
      try {
        const actor = await authorized(request, true);
        if (actor instanceof Response) return actor;
        await dependencies.remove(actor, id);
        return json({ removed: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
