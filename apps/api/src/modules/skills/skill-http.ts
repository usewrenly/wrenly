// Personal Skill endpoints check session and origin before bounded UTF-8 parsing.
import { z } from "zod";
import { AccessDeniedError } from "../auth/access/access-policy";
import { ProjectAccessError } from "../projects/access/project-access";
import { SkillError } from "./skill-contract";
import { logger } from "../../lib/logger";
const MAX_BODY_BYTES = 128 * 1024;
const BODY_TIMEOUT_MS = 5000;
const UUID = z.string().uuid();
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export interface SkillHttpServices {
  userId: (headers: Headers) => Promise<string | null>;
  list: (actorId: string) => Promise<unknown>;
  get: (actorId: string, skillId: string) => Promise<unknown>;
  create: (actorId: string, body: unknown) => Promise<unknown>;
  save: (actorId: string, skillId: string, body: unknown) => Promise<unknown>;
  status: (
    actorId: string,
    skillId: string,
    requestId: string,
  ) => Promise<unknown>;
}
export interface SkillHandlers {
  list: (request: Request) => Promise<Response>;
  get: (request: Request, id: string) => Promise<Response>;
  create: (request: Request) => Promise<Response>;
  save: (request: Request, id: string) => Promise<Response>;
  status: (
    request: Request,
    id: string,
    requestId: string,
  ) => Promise<Response>;
}
async function readBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new SkillError(400, "Send skill changes as JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new SkillError(400, "A skill document is required.");
  let expired = false;
  const timeout = setTimeout(() => {
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
        throw new SkillError(400, "This skill change is too large.");
      chunks.push(part.value);
    }
    if (expired)
      throw new SkillError(400, "Reading the skill change timed out.");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch {
      throw new SkillError(400, "Send valid UTF-8 JSON skill data.");
    }
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function boundary(
  userId: SkillHttpServices["userId"],
  webUrl: string,
): (
  request: Request,
  ids: string[],
  write: boolean,
  run: (actor: string, body: unknown) => Promise<unknown>,
) => Promise<Response> {
  const origin = new URL(webUrl).origin;
  return async (request, ids, write, run): Promise<Response> => {
    try {
      const actor = await userId(request.headers);
      if (!actor)
        return Response.json(
          { error: "Sign in to open skills." },
          { status: 401, headers: HEADERS },
        );
      if (ids.some((id) => !UUID.safeParse(id).success))
        throw new SkillError(
          400,
          "Choose valid skill, project and change identifiers.",
        );
      if (write && request.headers.get("origin") !== origin)
        return Response.json(
          { error: "Save skills from this instance's web address." },
          { status: 403, headers: HEADERS },
        );
      const result = await run(
        actor,
        write ? await readBody(request) : undefined,
      );
      return Response.json(result, { headers: HEADERS });
    } catch (error) {
      if (error instanceof SkillError || error instanceof ProjectAccessError)
        return Response.json(
          { error: error.message },
          { status: error.status, headers: HEADERS },
        );
      if (error instanceof AccessDeniedError)
        return Response.json(
          { error: error.message },
          { status: 401, headers: HEADERS },
        );
      logger.error("Skill request failed", {
        write,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return Response.json(
        {
          error:
            "This skill request could not be confirmed. Keep your text and check before retrying.",
        },
        { status: 503, headers: HEADERS },
      );
    }
  };
}
/** Narrow personal-library endpoints never infer, fetch source URLs or execute imported content. */
export function createSkillHandlers(
  services: SkillHttpServices,
  webUrl: string,
): SkillHandlers {
  const handle = boundary(services.userId, webUrl);
  return {
    list: (request) =>
      handle(request, [], false, (actor) => services.list(actor)),
    get: (request, id) =>
      handle(request, [id], false, (actor) => services.get(actor, id)),
    create: (request) =>
      handle(request, [], true, (actor, body) => services.create(actor, body)),
    save: (request, id) =>
      handle(request, [id], true, (actor, body) =>
        services.save(actor, id, body),
      ),
    status: (request, id, requestId) =>
      handle(request, [id, requestId], false, (actor) =>
        services.status(actor, id, requestId),
      ),
  };
}
export interface ProjectSkillHandlers {
  get: (request: Request, id: string) => Promise<Response>;
  save: (request: Request, id: string) => Promise<Response>;
}
export function createProjectSkillHandlers(
  services: {
    userId: SkillHttpServices["userId"];
    get: SkillHttpServices["get"];
    save: SkillHttpServices["save"];
  },
  webUrl: string,
): ProjectSkillHandlers {
  const handle = boundary(services.userId, webUrl);
  return {
    get: (request, id) =>
      handle(request, [id], false, (actor) => services.get(actor, id)),
    save: (request, id) =>
      handle(request, [id], true, (actor, body) =>
        services.save(actor, id, body),
      ),
  };
}
