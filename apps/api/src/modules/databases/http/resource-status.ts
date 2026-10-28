/**
 * COMPONENT: Database resource status HTTP boundary
 * PURPOSE: Give signed-in project readers bounded resource/operation metadata only.
 * INPUTS: GET, explicit project ID, current session and authorized status service.
 * OUTPUTS: Validated private JSON, never credentials or execution effects.
 * STEPS: Authenticate, validate request, read authorized status, check shape/project,
 * recheck session and cancellation, then return without caching.
 * EDGE CASES: Cross-project/duplicate/secret fields fail closed; no work starts here.
 * ERROR STATES: Fixed safe access/unavailable messages; unmounted until production wiring.
 */
import { z } from "zod";
import { DatabaseResourceStatus, DATABASE_STATUS_LIMITS } from "@wrenly/db/app-database-resource-contract";

const UUID = z.string().uuid();
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
interface ResourceStatusServices {
  userId: (headers: Headers) => Promise<string | null>;
  /** Must authorize project read and recheck access revisions before returning. */
  read: (projectId: string, actorId: string) => Promise<unknown>;
}

/** Creating this handler does not register a route or activate database execution. */
export function createDatabaseResourceStatusHandler(services: ResourceStatusServices):
  (request: Request, projectId: string) => Promise<Response> {
  return async (request, projectId): Promise<Response> => {
    const failure = (status: number, error: string): Response => Response.json({ error }, { status, headers: HEADERS });
    try {
      const actor = await services.userId(request.headers);
      if (!actor) return failure(401, "Sign in to view database status.");
      if (request.method !== "GET") return Response.json({ error: "Use GET to view database status." },
        { status: 405, headers: { ...HEADERS, Allow: "GET" } });
      if (!UUID.safeParse(projectId).success || new URL(request.url).search)
        return failure(400, "Choose a valid project without additional database status parameters.");
      request.signal.throwIfAborted();
      const value = DatabaseResourceStatus.parse(await services.read(projectId, actor));
      if (value.resources.some(resource => resource.projectId !== projectId))
        return failure(503, "Database status could not be verified.");
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > DATABASE_STATUS_LIMITS.bytes)
        return failure(503, "Database status exceeds its display limit.");
      if (await services.userId(request.headers) !== actor)
        return failure(401, "Your session changed. Sign in again before viewing database status.");
      request.signal.throwIfAborted();
      return new Response(body, { headers: { ...HEADERS, "Content-Type": "application/json" } });
    } catch (error) {
      // Only fixed access messages cross this boundary; arbitrary service failures
      // must not expose provider responses, SQL, secrets or filesystem paths.
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      if (status === 403) return failure(403, "Your project access changed. Reload before viewing database status.");
      if (status === 404) return failure(404, "Project not found.");
      return failure(503, "Database status could not be loaded. Reload to try again.");
    }
  };
}
