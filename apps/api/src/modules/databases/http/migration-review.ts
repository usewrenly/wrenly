/** Owner-only, bounded review reads return saved migration text; no source executes at this boundary. */
import { z } from "zod";
import { DatabaseMigrationReview } from "@wrenly/db/app-database-resource-contract";
const UUID = z.string().uuid();
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
interface Services {
  userId: (headers: Headers) => Promise<string | null>;
  read: (projectId: string, actorId: string, resourceId: string, buildId: string) => Promise<unknown>;
}
/** The read service must enforce current ownership and return only the requested saved identities. */
export function createDatabaseMigrationReviewHandler(services: Services):
  (request: Request, projectId: string) => Promise<Response> {
  return async (request, projectId): Promise<Response> => {
    const failure = (status: number, error: string): Response => Response.json({ error }, { status, headers: HEADERS });
    try {
      const actor = await services.userId(request.headers);
      if (!actor) return failure(401, "Sign in to review database changes.");
      if (request.method !== "GET") return Response.json({ error: "Use GET to review database changes." }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
      const parameters = new URL(request.url).searchParams;
      const selection = z.object({ resourceId: UUID, buildId: UUID }).safeParse(Object.fromEntries(parameters));
      const resourceId = selection.success ? selection.data.resourceId : "", buildId = selection.success ? selection.data.buildId : "";
      if (!UUID.safeParse(projectId).success || !selection.success ||
          [...parameters.keys()].length !== 2)
        return failure(400, "Select an exact database and saved revision for review.");
      request.signal.throwIfAborted();
      const review = DatabaseMigrationReview.parse(await services.read(projectId, actor, resourceId, buildId));
      if (review.projectId !== projectId || review.resourceId !== resourceId || review.buildId !== buildId)
        return failure(503, "The selected database review could not be verified.");
      if (await services.userId(request.headers) !== actor) return failure(401, "Your session changed. Sign in again.");
      request.signal.throwIfAborted();
      return Response.json(review, { headers: HEADERS });
    } catch (error) {
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      if (status === 403 || status === 404 || status === 409)
        return failure(status, "Database review is unavailable. Check project access, the resource and the saved revision.");
      return failure(503, "Database review could not be loaded.");
    }
  };
}
