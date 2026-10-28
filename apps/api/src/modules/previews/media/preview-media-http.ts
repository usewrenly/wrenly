// Authenticates and bounds media-setting requests before durable owner-only policy changes.
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  readPreviewMediaPolicy,
  savePreviewMediaPolicy,
} from "./preview-media-store";
import { PreviewMediaError } from "./preview-media-contract";
import { ProjectAccessError } from "../../projects/access/project-access";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { logger } from "../../../lib/logger";
const MAX_BODY_BYTES = 4096,
  BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
type Handler = (request: Request, id: string) => Promise<Response>;
export interface PreviewMediaHandlers {
  get: Handler;
  save: Handler;
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new PreviewMediaError(400, "Send media settings as JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new PreviewMediaError(400, "Media settings are required.");
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, BODY_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY_BYTES)
        throw new PreviewMediaError(
          400,
          "Media settings exceed their size limit.",
        );
      chunks.push(part.value);
    }
    if (expired)
      throw new PreviewMediaError(400, "Reading media settings timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new PreviewMediaError(400, "Send valid JSON media settings.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Writes accept only this instance's web origin; all results are private and uncached. */
export function createPreviewMediaHandlers(
  database: typeof db,
  configuration: {
    webUrl: string;
    userId: (headers: Headers) => Promise<string | null>;
  },
): PreviewMediaHandlers {
  const handle =
    (write: boolean): Handler =>
    async (request, id) => {
      try {
        const actor = await configuration.userId(request.headers);
        if (!actor)
          return Response.json(
            { error: "Sign in to access preview media settings." },
            { status: 401, headers: HEADERS },
          );
        if (!z.string().uuid().safeParse(id).success)
          throw new PreviewMediaError(400, "Invalid project ID.");
        if (
          write &&
          request.headers.get("origin") !== new URL(configuration.webUrl).origin
        )
          throw new PreviewMediaError(
            403,
            "Save media settings from this instance.",
          );
        const policy = write
          ? await savePreviewMediaPolicy(
              database,
              id,
              actor,
              await body(request),
            )
          : await readPreviewMediaPolicy(database, id, actor);
        return Response.json(policy, { headers: HEADERS });
      } catch (error) {
        if (error instanceof AccessDeniedError)
          return Response.json(
            { error: error.message },
            { status: 401, headers: HEADERS },
          );
        if (
          error instanceof ProjectAccessError ||
          error instanceof PreviewMediaError
        )
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        logger.error("Preview media request failed", {
          projectId: id,
          operation: write ? "save" : "read",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return Response.json(
          { error: "Preview media request could not be completed." },
          { status: 503, headers: HEADERS },
        );
      }
    };
  return { get: handle(false), save: handle(true) };
}
