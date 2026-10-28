/** Owner-only review exposes bounded inspection choices, never external effect identities or execution. */
import { z } from "zod";
import { DatabaseRecoveryReview } from "@wrenly/db/app-database-resource-contract";
const UUID = z.string().uuid();
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
interface Services {
  userId: (headers: Headers) => Promise<string | null>;
  read: (projectId: string, actorId: string, resourceId: string, operationId: string) => Promise<unknown>;
}
/** The read service must enforce current ownership and return only the requested saved identities. */
export function createDatabaseRecoveryReviewHandler(services: Services):
  (request: Request, projectId: string) => Promise<Response> {
  return async (request, projectId): Promise<Response> => {
    const failure = (status: number, error: string): Response => Response.json({ error }, { status, headers: HEADERS });
    try {
      const actor = await services.userId(request.headers);
      if (!actor) return failure(401, "Sign in to review database recovery.");
      if (request.method !== "GET") return Response.json({ error: "Use GET to review database recovery." }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
      const parameters = new URL(request.url).searchParams;
      const selection = z.object({ resourceId: UUID, operationId: UUID }).safeParse(Object.fromEntries(parameters));
      const resourceId = selection.success ? selection.data.resourceId : "", operationId = selection.success ? selection.data.operationId : "";
      if (!UUID.safeParse(projectId).success || !selection.success ||
          [...parameters.keys()].length !== 2)
        return failure(400, "Select an exact database and interrupted operation for review.");
      request.signal.throwIfAborted();
      const review = DatabaseRecoveryReview.parse(await services.read(projectId, actor, resourceId, operationId));
      if (review.projectId !== projectId || review.resourceId !== resourceId || review.operationId !== operationId)
        return failure(503, "The selected recovery review could not be verified.");
      if (await services.userId(request.headers) !== actor) return failure(401, "Your session changed. Sign in again.");
      request.signal.throwIfAborted();
      return Response.json(review, { headers: HEADERS });
    } catch (error) {
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      if (status === 403 || status === 404 || status === 409)
        return failure(status, "Database review is unavailable. Check project access, the resource and the interrupted operation.");
      return failure(503, "Database review could not be loaded.");
    }
  };
}
