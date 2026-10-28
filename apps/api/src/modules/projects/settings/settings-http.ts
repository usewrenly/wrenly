/**
 * Project details HTTP adapter.
 * Session/origin checks and bounded JSON precede owner persistence.
 * Conflicts and uncertain saves remain explicit instead of pretending success or resetting the editor.
 */
import { AccessDeniedError } from "../../auth/access/access-policy";
import { logger } from "../../../lib/logger";
import {
  ProjectSettingsError,
  ProjectSettingsInput,
  type ProjectDetails,
  type SettingsInput,
} from "./settings-contract";
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "no-store, private", Vary: "Cookie" };
type Handler = (request: Request, id: string) => Promise<Response>;
export interface ProjectSettingsHandlers {
  get: Handler;
  save: Handler;
}
async function readInput(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ProjectSettingsError(400, "Send project settings as JSON.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new ProjectSettingsError(400, "Project details are required.");
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
        throw new ProjectSettingsError(413, "Project details are too large.");
      chunks.push(part.value);
    }
    if (expired)
      throw new ProjectSettingsError(
        408,
        "Reading project details timed out. Try again.",
      );
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ProjectSettingsError(
        400,
        "Project details must be valid JSON.",
      );
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Adds safe authenticated handlers while keeping database mutation injectable for ownership/concurrency tests. */
export function createProjectSettingsHandlers(dependencies: {
  webUrl: string;
  userId: (headers: Headers) => Promise<string | null>;
  read: (userId: string, id: string) => Promise<ProjectDetails>;
  save: (
    userId: string,
    id: string,
    input: SettingsInput,
  ) => Promise<ProjectDetails>;
}): ProjectSettingsHandlers {
  const handle =
    (write: boolean): Handler =>
    async (request, id) => {
      try {
        const userId = await dependencies.userId(request.headers);
        if (!userId)
          throw new ProjectSettingsError(
            401,
            "Sign in to manage this project.",
          );
        if (
          write &&
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          throw new ProjectSettingsError(
            403,
            "Save settings from this instance’s trusted web address.",
          );
        if (!write)
          return Response.json(
            { project: await dependencies.read(userId, id) },
            { headers: HEADERS },
          );
        const parsed = ProjectSettingsInput.safeParse(await readInput(request));
        if (!parsed.success)
          throw new ProjectSettingsError(
            400,
            "Use a project name of 1–100 characters and a description of up to 500 characters. Only project details can be changed here.",
          );
        return Response.json(
          { project: await dependencies.save(userId, id, parsed.data) },
          { headers: HEADERS },
        );
      } catch (error) {
        if (error instanceof AccessDeniedError)
          return Response.json({ error: error.message }, { status: 401 });
        if (error instanceof ProjectSettingsError)
          return Response.json(
            {
              error: error.message,
              ...(error.current ? { current: error.current } : {}),
            },
            { status: error.status, headers: HEADERS },
          );
        logger.error("Project settings operation failed", {
          projectId: id,
          operation: write ? "save" : "read",
          errorName: error instanceof Error ? error.name : "Unknown",
        });
        return Response.json(
          {
            error:
              "Project settings are unavailable. Your changes have not been confirmed. Try again.",
          },
          { status: 503, headers: HEADERS },
        );
      }
    };
  return { get: handle(false), save: handle(true) };
}
