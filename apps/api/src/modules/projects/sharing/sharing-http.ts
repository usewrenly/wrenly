/**
 * Sharing and model HTTP boundary.
 * Authenticates before bounded input handling, verifies trusted origins for writes and delegates authority/replay to the centralized stores.
 * Never trusts browser role declarations.
 */
import { z } from "zod";
import {
  getProjectSharing,
  changeProjectSharing,
  getProjectAccessAction,
  SharingError,
} from "./project-sharing";
import { changeProjectModel, ProjectModelError } from "./project-model";
import { ProjectAccessError } from "../access/project-access";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { logger } from "../../../lib/logger";
import type { db } from "@wrenly/db";
const UUID = z.string().uuid(),
  MAX_BODY_BYTES = 32768,
  BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export interface SharingHandlers {
  get: (request: Request, id: string) => Promise<Response>;
  save: (request: Request, id: string) => Promise<Response>;
  model: (request: Request, id: string) => Promise<Response>;
  status: (request: Request, id: string, key: string) => Promise<Response>;
}
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new SharingError(400, "Send project access settings as JSON.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new SharingError(400, "Review the project settings before saving.");
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, BODY_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES)
        throw new SharingError(400, "This access change is too large.");
      chunks.push(part.value);
    }
    if (expired)
      throw new SharingError(400, "Reading the access change timed out.");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new SharingError(400, "Send valid JSON access settings.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Narrow project administration; instance membership never implies these permissions. */
export function createSharingHandlers(
  database: typeof db,
  session: (headers: Headers) => Promise<string | null>,
  webUrl: string,
): SharingHandlers {
  const handle = async (
    request: Request,
    id: string,
    write: boolean,
    run: (actor: string) => Promise<unknown>,
  ): Promise<Response> => {
    try {
      const actor = await session(request.headers);
      if (!actor)
        return Response.json(
          { error: "Sign in to open this project." },
          { status: 401, headers: HEADERS },
        );
      if (!UUID.safeParse(id).success)
        throw new SharingError(400, "Choose a valid project.");
      if (write && request.headers.get("origin") !== new URL(webUrl).origin)
        return Response.json(
          { error: "Save access from this instance’s trusted web address." },
          { status: 403, headers: HEADERS },
        );
      return Response.json(await run(actor), { headers: HEADERS });
    } catch (error) {
      if (error instanceof AccessDeniedError)
        return Response.json(
          { error: error.message },
          { status: 401, headers: HEADERS },
        );
      if (
        error instanceof ProjectAccessError ||
        error instanceof SharingError ||
        error instanceof ProjectModelError
      )
        return Response.json(
          { error: error.message },
          { status: error.status, headers: HEADERS },
        );
      logger.error("Project sharing request failed", {
        projectId: id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return Response.json(
        {
          error:
            "The access change could not be confirmed. Check saved access before retrying.",
        },
        { status: 503, headers: HEADERS },
      );
    }
  };
  return {
    get: (request, id) =>
      handle(request, id, false, (actor) =>
        getProjectSharing(
          database,
          id,
          actor,
          new URL(request.url).searchParams.get("search") ?? "",
        ),
      ),
    save: (request, id) =>
      handle(request, id, true, async (actor) =>
        changeProjectSharing(database, id, actor, await readBody(request)),
      ),
    model: (request, id) =>
      handle(request, id, true, async (actor) =>
        changeProjectModel(database, id, actor, await readBody(request)),
      ),
    status: (request, id, key) =>
      handle(request, id, false, async (actor) => {
        if (!UUID.safeParse(key).success)
          throw new SharingError(400, "Use a valid change identifier.");
        return {
          action: await getProjectAccessAction(database, id, actor, key),
        };
      }),
  };
}
