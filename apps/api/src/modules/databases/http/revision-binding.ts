/**
 * COMPONENT: Revision compatibility HTTP read
 * PURPOSE: Let an authorized interface check exact code/database compatibility without starting work.
 * INPUTS: GET with one exact Development binding request and a verified session.
 * OUTPUTS: A bounded non-secret binding snapshot, or a safe fixed failure.
 * STEPS: Check method/IDs/query, authenticate, delegate current compatibility checks,
 * validate matching response identities, recheck session and cancellation, return privately.
 * EDGE CASES: Duplicate query fields, cross-project results and secret fields are rejected.
 * ERROR STATES: No implicit latest revision, provisioning, migration or socket execution.
 */
import { DatabaseBindingRequest, DatabaseRevisionBinding } from "@wrenly/db/app-database-binding-contract";
const MAX_QUERY_LENGTH = 1024;
const QUERY_FIELDS = 4;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
interface Services {
  userId: (headers: Headers) => Promise<string | null>;
  read: (projectId: string, actorId: string, request: DatabaseBindingRequest) => Promise<unknown>;
}
/** Creating the handler does not mount a route or grant runtime/row-query authority. */
export function createDatabaseRevisionBindingHandler(services: Services):
  (request: Request, projectId: string) => Promise<Response> {
  return async (request, projectId) => {
    try {
      const actor = await services.userId(request.headers);
      if (!actor) return Response.json({ error: "Sign in to check this revision's database." }, { status: 401, headers: HEADERS });
      if (request.method !== "GET") return Response.json({ error: "Use GET to check revision compatibility." }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
      const url = new URL(request.url);
      const input = DatabaseBindingRequest.safeParse(Object.fromEntries(url.searchParams));
      if (!DatabaseRevisionBinding.shape.projectId.safeParse(projectId).success || url.search.length > MAX_QUERY_LENGTH ||
        url.searchParams.size !== QUERY_FIELDS || !input.success)
        return Response.json({ error: "Choose the exact Development database and code revision." }, { status: 400, headers: HEADERS });
      request.signal.throwIfAborted();
      const binding = DatabaseRevisionBinding.parse(await services.read(projectId, actor, input.data));
      if (binding.projectId !== projectId || binding.buildId !== input.data.buildId || binding.resourceId !== input.data.resourceId ||
        binding.resourceRevision !== input.data.resourceRevision || binding.environment !== input.data.environment)
        throw new Error("Mismatched binding result");
      if (await services.userId(request.headers) !== actor)
        return Response.json({ error: "Your session changed. Sign in again before checking this revision." }, { status: 401, headers: HEADERS });
      request.signal.throwIfAborted();
      return Response.json(binding, { headers: HEADERS });
    } catch (error) {
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      const code = status === 400 || status === 403 || status === 404 || status === 409 ? status : 503;
      return Response.json({ error: code === 409 ? "The saved code and database do not currently match. Review migrations and current access."
        : code === 404 ? "Project or revision database not found." : "Revision compatibility could not be verified." }, { status: code, headers: HEADERS });
    }
  };
}
