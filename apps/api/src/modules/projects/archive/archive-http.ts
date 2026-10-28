/**
 * Project archive HTTP boundary.
 * Bounded explicit owner actions carry expected revision and durable request identity.
 * Reads never archive or restore; errors preserve the need to review conflicts or unconfirmed changes.
 */
import { z } from "zod";
import type { db } from "@wrenly/db";
import { readProjectArchive, changeProjectArchive } from "./project-archive";
import { ProjectArchiveError } from "./project-archive";
import { ProjectAccessError } from "../access/project-access";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { logger } from "../../../lib/logger";
const MAX_BODY_BYTES = 4096,
  BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
type Handler = (request: Request, id: string) => Promise<Response>;
export interface ProjectArchiveHandlers {
  get: Handler;
  save: Handler;
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ProjectArchiveError(400, "Send archive settings as JSON.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new ProjectArchiveError(400, "Archive settings are required.");
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
        throw new ProjectArchiveError(
          400,
          "Archive settings exceed their size limit.",
        );
      chunks.push(part.value);
    }
    if (expired)
      throw new ProjectArchiveError(400, "Reading archive settings timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ProjectArchiveError(400, "Send valid JSON archive settings.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Writes accept only this instance's web origin; all results are private and uncached. */
export function createProjectArchiveHandlers(
  database: typeof db,
  configuration: {
    webUrl: string;
    userId: (headers: Headers) => Promise<string | null>;
  },
): ProjectArchiveHandlers {
  const handle =
    (write: boolean): Handler =>
    async (request, id) => {
      try {
        const actor = await configuration.userId(request.headers);
        if (!actor)
          return Response.json(
            { error: "Sign in to access project archive settings." },
            { status: 401, headers: HEADERS },
          );
        if (!z.string().uuid().safeParse(id).success)
          throw new ProjectArchiveError(400, "Invalid project ID.");
        if (
          write &&
          request.headers.get("origin") !== new URL(configuration.webUrl).origin
        )
          throw new ProjectArchiveError(
            403,
            "Save archive settings from this instance.",
          );
        const policy = write
          ? await changeProjectArchive(database, id, actor, await body(request))
          : await readProjectArchive(database, id, actor);
        return Response.json(policy, { headers: HEADERS });
      } catch (error) {
        if (error instanceof AccessDeniedError)
          return Response.json(
            { error: error.message },
            { status: 401, headers: HEADERS },
          );
        if (
          error instanceof ProjectAccessError ||
          error instanceof ProjectArchiveError
        )
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        logger.error("Project archive request failed", {
          projectId: id,
          operation: write ? "save" : "read",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return Response.json(
          { error: "Project archive request could not be completed." },
          { status: 503, headers: HEADERS },
        );
      }
    };
  return { get: handle(false), save: handle(true) };
}
