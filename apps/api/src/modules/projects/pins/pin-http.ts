/**
 * HTTP boundary for personal project pinning (`PATCH /api/projects/:id/pin`).
 * Enforces session identity, UUID validation, trusted Origin, bounded JSON body, and strict boolean input.
 */
import { z } from "zod";
import type { db } from "@wrenly/db";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { ProjectAccessError } from "../access/project-access";
import { ProjectPinError, setProjectPin } from "./project-pins";
import { logger } from "../../../lib/logger";

const MAX_BODY_BYTES = 1024;
const BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const PinPayloadSchema = z.object({ pinned: z.boolean() }).strict();

type Handler = (request: Request, id: string) => Promise<Response>;

export interface ProjectPinHandlers {
  save: Handler;
}

async function readPinBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw new ProjectPinError(400, "Send pin preferences as JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new ProjectPinError(400, "Pin preference is required.");
  }
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
      if (length > MAX_BODY_BYTES) {
        throw new ProjectPinError(400, "Pin preference exceeds its size limit.");
      }
      chunks.push(part.value);
    }
    if (expired) {
      throw new ProjectPinError(400, "Reading pin preference timed out.");
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ProjectPinError(400, "Send a valid JSON pin preference.");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Creates the HTTP handler for pinning/unpinning a project under the caller's account.
 */
export function createProjectPinHandlers(
  database: typeof db,
  configuration: {
    webUrl: string;
    userId: (headers: Headers) => Promise<string | null>;
  },
): ProjectPinHandlers {
  return {
    save: async (request, id): Promise<Response> => {
      try {
        const actor = await configuration.userId(request.headers);
        if (!actor) {
          return Response.json(
            { error: "Sign in to pin projects." },
            { status: 401, headers: HEADERS },
          );
        }
        if (!z.string().uuid().safeParse(id).success) {
          throw new ProjectPinError(400, "Invalid project ID.");
        }
        if (
          request.headers.get("origin") !== new URL(configuration.webUrl).origin
        ) {
          throw new ProjectPinError(403, "Pin projects from this instance.");
        }
        const parsed = PinPayloadSchema.safeParse(await readPinBody(request));
        if (!parsed.success) {
          throw new ProjectPinError(
            400,
            "Provide a valid boolean pin state.",
          );
        }
        const state = await setProjectPin(
          database,
          id,
          actor,
          parsed.data.pinned,
        );
        return Response.json(state, { headers: HEADERS });
      } catch (error) {
        if (error instanceof AccessDeniedError) {
          return Response.json(
            { error: error.message },
            { status: 401, headers: HEADERS },
          );
        }
        if (
          error instanceof ProjectAccessError ||
          error instanceof ProjectPinError
        ) {
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        }
        logger.error("Project pin update failed", {
          projectId: id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return Response.json(
          { error: "Project pin preference could not be updated." },
          { status: 503, headers: HEADERS },
        );
      }
    },
  };
}
