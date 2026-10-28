/**
 * COMPONENT: Explicit database action HTTP boundary
 * PURPOSE: Admit owner-reviewed actions and retrieve their saved receipts after lost responses.
 * INPUTS: Current session, trusted-origin bounded POST or actor-scoped receipt GET.
 * OUTPUTS: Validated saved acknowledgement, never execution results or runtime secrets.
 * STEPS: Authenticate, validate method/origin/IDs/body, recheck session, delegate to
 * transactional owner admission or authorized lookup, then validate the response.
 * EDGE CASES: No session recheck after a successful admission may disguise a saved
 * operation as denied. Lost responses require receipt lookup, not a new request UUID.
 * ERROR STATES: Fixed safe failures; no route is mounted and no worker starts here.
 */
import { z } from "zod";
import { DatabaseActionAcknowledgement } from "@wrenly/db/app-database-action-contract";
import { readDatabaseActionInput, DatabaseActionInputError } from "./action-input";
const UUID = z.string().uuid();
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
export interface DatabaseCommandServices<T> {
  userId: (headers: Headers) => Promise<string | null>;
  admit: (project: string, actor: string, action: T) => Promise<unknown>;
  lookup: (project: string, actor: string, requestId: string) => Promise<unknown>;
}
export interface DatabaseCommandHandlers {
  submit: (request: Request, projectId: string) => Promise<Response>;
  acknowledgement: (request: Request, projectId: string, requestId: string) => Promise<Response>;
}
const failure = (status: number, error: string): Response => Response.json({ error }, { status, headers: HEADERS });

/** Services must enforce current owner/access, ordered locks, exact replay and archived-history policy.
 * Only the validator result is consumed here; keeping its type narrow avoids coupling
 * this shared boundary to Zod schema internals and expensive generic type expansion.
 */
export function createDatabaseCommandHandlers<T>(schema: { safeParse: (body: unknown) => { success: true; data: T } | { success: false } }, services: DatabaseCommandServices<T>, webUrl: string): DatabaseCommandHandlers {
  const address = new URL(webUrl);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password)
    throw new Error("Database actions require a trusted HTTP web origin.");
  const handle = async (request: Request, projectId: string, requestId?: string): Promise<Response> => {
    try {
      const actor = await services.userId(request.headers);
      if (!actor) return failure(401, "Sign in to manage this project's database.");
      const write = requestId === undefined;
      const method = write ? "POST" : "GET";
      if (request.method !== method) return Response.json({ error: `Use ${method} for this database action.` },
        { status: 405, headers: { ...HEADERS, Allow: method } });
      if (!UUID.safeParse(projectId).success || new URL(request.url).search ||
          (!write && !UUID.safeParse(requestId).success))
        return failure(400, "Choose the exact project and saved database action.");
      if (write && request.headers.get("origin") !== address.origin)
        return failure(403, "Submit database actions from this instance's trusted web address.");
      request.signal.throwIfAborted();
      if (write) {
        const action = schema.safeParse(await readDatabaseActionInput(request));
        if (!action.success) return failure(400, "Review the database action, confirmation and current revision.");
        if (await services.userId(request.headers) !== actor)
          return failure(401, "Your session changed. Sign in again before submitting.");
        request.signal.throwIfAborted();
        const receipt = DatabaseActionAcknowledgement.parse(await services.admit(projectId, actor, action.data));
        return Response.json(receipt, { status: receipt.replayed ? 200 : 202, headers: HEADERS });
      }
      const result = await services.lookup(projectId, actor, requestId!);
      const receipt = result === null ? null : DatabaseActionAcknowledgement.parse(result);
      if (await services.userId(request.headers) !== actor)
        return failure(401, "Your session changed. Sign in again before checking the action.");
      request.signal.throwIfAborted();
      return Response.json({ acknowledgement: receipt }, { headers: HEADERS });
    } catch (error) {
      const status = error instanceof DatabaseActionInputError ? error.status
        : error instanceof Error && "status" in error ? error.status : undefined;
      if (typeof status === "number" && [400, 403, 404, 408, 409, 413, 415, 429].includes(status))
        return failure(status, status === 409 ? "The database changed or work is still active. Reload before reviewing another action."
          : status === 404 ? "Project or saved database action not found."
          : "The database action could not be accepted. Check access and review the request.");
      return failure(503, "The database action could not be confirmed. Check its saved acknowledgement before trying again.");
    }
  };
  return { submit: (request, project) => handle(request, project),
    acknowledgement: (request, project, requestId) => handle(request, project, requestId) };
}
