/** Private setup transport. Construction neither mounts routes nor starts verification. */
import { z } from "zod";
import type { AccessPrincipal } from "../../../auth/access/access-context";
import { readDatabaseActionInput } from "../../http/action-input";
import { ProductionSetupInput } from "./credentials";
const UUID = z.uuid();
const Receipt = z.object({ setupId: UUID, status: z.enum(["queued", "checking", "verified", "failed", "needs_review"]), replayed: z.boolean() }).strict();
const Acknowledgement = z.object({ requestId: UUID, expectedRevision: UUID, confirmInterruptedCheck: z.literal(true) }).strict();
const MAX_SETUP_BODY_BYTES = 24 * 1024;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
export interface ProductionSetupHttpServices {
  principal: (headers: Headers) => Promise<AccessPrincipal | null>;
  admit: (principal: AccessPrincipal, projectId: string, input: ProductionSetupInput) => Promise<unknown>;
  read: (principal: AccessPrincipal, projectId: string, requestId: string) => Promise<unknown>;
  acknowledge: (principal: AccessPrincipal, projectId: string, input: z.infer<typeof Acknowledgement>) => Promise<unknown>;
}
export interface ProductionSetupHttpHandlers {
  submit: (request: Request, projectId: string) => Promise<Response>;
  status: (request: Request, projectId: string, requestId: string) => Promise<Response>;
  acknowledge: (request: Request, projectId: string) => Promise<Response>;
}
/** Owner authority remains transactional in the store; identity is rechecked before returning a receipt. */
export function createProductionSetupHttpHandlers(services: ProductionSetupHttpServices, webUrl: string): ProductionSetupHttpHandlers {
  const origin = new URL(webUrl).origin;
  const failure = (status: number, error: string): Response => Response.json({ error }, { status, headers: HEADERS });
  async function run(request: Request, projectId: string, action: "submit" | "status" | "acknowledge", requestId?: string): Promise<Response> {
    try {
      const actor = await services.principal(request.headers);
      if (!actor) return failure(401, "Sign in before reviewing Production setup.");
      const method = action === "status" ? "GET" : "POST";
      if (request.method !== method) return new Response(null, { status: 405, headers: { ...HEADERS, Allow: method } });
      if (!UUID.safeParse(projectId).success || new URL(request.url).search) return failure(400, "Choose a valid project and setup request.");
      if (action !== "status" && request.headers.get("origin") !== origin) return failure(403, "Open Production setup from this Wrenly instance.");
      request.signal.throwIfAborted();
      let result: unknown;
      if (action === "status") {
        if (!UUID.safeParse(requestId).success) return failure(400, "Choose a valid setup request.");
        result = await services.read(actor, projectId, requestId!);
        if (result === null) return failure(404, "Production setup not found.");
      } else {
        const raw = await readDatabaseActionInput(request, MAX_SETUP_BODY_BYTES);
        if (action === "submit") result = await services.admit(actor, projectId, ProductionSetupInput.parse(raw));
        else result = await services.acknowledge(actor, projectId, Acknowledgement.parse(raw));
      }
      const parsed = Receipt.safeParse(result);
      if (!parsed.success) return failure(503, "Production setup result could not be verified.");
      const value = parsed.data;
      const current = await services.principal(request.headers);
      if (!current || current.userId !== actor.userId || current.sessionId !== actor.sessionId || current.revision !== actor.revision) return failure(401, "Your session changed. Sign in and review the saved setup status.");
      request.signal.throwIfAborted();
      return Response.json(value, { status: action === "submit" && !value.replayed ? 202 : 200, headers: HEADERS });
    } catch (error) {
      if (error instanceof z.ZodError) return failure(400, "Review the setup fields and explicit confirmation.");
      const status = error instanceof Error && "status" in error ? error.status : undefined;
      if (status === 403 || status === 404) return failure(status, "Production setup is not available with your current project access.");
      if (status === 409) return failure(409, "Setup changed or work is still active. Reload its saved status before continuing.");
      if (status === 429) return failure(429, "Setup capacity is full. Wait for current checks to finish.");
      if (status === 400 || status === 408 || status === 413 || status === 415) return failure(status, "Send a bounded JSON setup request.");
      return failure(503, "Production setup could not be confirmed. Read its saved status before trying again.");
    }
  }
  return {
    submit: (request, projectId) => run(request, projectId, "submit"),
    status: (request, projectId, requestId) => run(request, projectId, "status", requestId),
    acknowledge: (request, projectId) => run(request, projectId, "acknowledge"),
  };
}
