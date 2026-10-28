/**
 * Draft HTTP adapter.
 * Authenticates reads, verifies write origins and bounds input before delegating content/sharing/archive actions.
 * Loading or saving an idea never invokes inference or creates a generated project.
 */
import { z } from "zod";
import type { db } from "@wrenly/db";
import { DraftError } from "./draft-contract";
import { AccessDeniedError } from "../../auth/access/access-policy";
import {
  listDrafts,
  readDraft,
  mutateDraft,
  draftCandidates,
} from "./draft-store";
import { logger } from "../../../lib/logger";
const MAX_BODY_BYTES = 256_000;
const BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export interface DraftHandlers {
  list: (request: Request) => Promise<Response>;
  create: (request: Request) => Promise<Response>;
  get: (request: Request, id: string) => Promise<Response>;
  save: (request: Request, id: string) => Promise<Response>;
  candidates: (request: Request, id: string) => Promise<Response>;
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new DraftError(400, "Send draft data as JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new DraftError(400, "Draft data are required.");
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
        throw new DraftError(400, "Draft data exceed their size limit.");
      chunks.push(part.value);
    }
    if (expired) throw new DraftError(400, "Reading draft data timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new DraftError(400, "Send valid JSON draft data.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Narrow draft routes never call model providers or generated-code execution. */
export function createDraftHandlers(
  database: typeof db,
  config: {
    webUrl: string;
    userId: (headers: Headers) => Promise<string | null>;
  },
): DraftHandlers {
  const handle = async (
    request: Request,
    kind: "list" | "get" | "create" | "save" | "candidates",
    id?: string,
  ): Promise<Response> => {
    try {
      const actor = await config.userId(request.headers);
      if (!actor)
        return Response.json(
          { error: "Sign in to access project drafts." },
          { status: 401, headers: HEADERS },
        );
      if (id !== undefined && !z.string().uuid().safeParse(id).success)
        throw new DraftError(400, "Invalid draft ID.");
      const write = kind === "save" || kind === "create";
      if (
        write &&
        request.headers.get("origin") !== new URL(config.webUrl).origin
      )
        throw new DraftError(403, "Save drafts from this instance.");
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(10_000)
        .safeParse(new URL(request.url).searchParams.get("offset") ?? "0");
      if (!offset.success) throw new DraftError(400, "Invalid draft page.");
      const search = new URL(request.url).searchParams.get("search") ?? "";
      if (search.length > 100)
        throw new DraftError(400, "Keep member search under 100 characters.");
      const result =
        kind === "list"
          ? await listDrafts(database, actor, offset.data)
          : kind === "get"
            ? { draft: await readDraft(database, id!, actor) }
            : kind === "candidates"
              ? await draftCandidates(database, id!, actor, search.trim())
              : await mutateDraft(database, actor, await body(request), id);
      return Response.json(result, { headers: HEADERS });
    } catch (error) {
      if (error instanceof DraftError)
        return Response.json(
          { error: error.message },
          { status: error.status, headers: HEADERS },
        );
      if (error instanceof AccessDeniedError)
        return Response.json(
          { error: error.message },
          { status: 401, headers: HEADERS },
        );
      logger.error("Draft request failed", {
        operation: kind,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return Response.json(
        { error: "Draft operation could not be confirmed." },
        { status: 503, headers: HEADERS },
      );
    }
  };
  return {
    list: (request) => handle(request, "list"),
    create: (request) => handle(request, "create"),
    get: (request, id) => handle(request, "get", id),
    save: (request, id) => handle(request, "save", id),
    candidates: (request, id) => handle(request, "candidates", id),
  };
}
