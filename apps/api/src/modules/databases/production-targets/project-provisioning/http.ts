/** Owner-confirmed Production creation transport; admission saves work and never executes SQL here. */
import { z } from "zod";
import {
  ProductionProjectRecoveryInput,
  ProductionProjectRecoveryReceipt,
  ProductionProjectCreationInput,
  ProductionProjectCreationReceipt,
  ProductionProjectCreationState,
} from "@wrenly/db/production-project-contract";
import type { AccessPrincipal } from "../../../auth/access/access-context";
import {
  readDatabaseActionInput,
  DatabaseActionInputError,
} from "../../http/action-input";
const HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
const MAX_CREATION_BYTES = 8 * 1024;
export interface ProjectProductionCreationServices {
  recover?: (
    principal: AccessPrincipal,
    projectId: string,
    input: ProductionProjectRecoveryInput,
  ) => Promise<unknown>;
  principal: (headers: Headers) => Promise<AccessPrincipal | null>;
  admit: (
    principal: AccessPrincipal,
    projectId: string,
    input: ProductionProjectCreationInput,
  ) => Promise<unknown>;
  read: (
    principal: AccessPrincipal,
    projectId: string,
    requestId?: string,
  ) => Promise<unknown>;
}
export interface ProjectProductionCreationHandlers {
  recovery: (request: Request, projectId: string) => Promise<Response>;
  submit: (request: Request, projectId: string) => Promise<Response>;
  status: (
    request: Request,
    projectId: string,
    requestId?: string,
  ) => Promise<Response>;
}
/** Stores independently enforce ownership, ordered locks, connection and access revisions; browser input never selects an actor. */
export function createProjectProductionCreationHandlers(
  services: ProjectProductionCreationServices,
  webUrl: string,
): ProjectProductionCreationHandlers {
  const origin = new URL(webUrl).origin;
  const failure = (status: number, error: string): Response =>
    Response.json({ error }, { status, headers: HEADERS });
  async function handle(
    request: Request,
    projectId: string,
    write: boolean,
    requestId?: string,
  ): Promise<Response> {
    try {
      const method = write ? "POST" : "GET";
      if (request.method !== method)
        return new Response(null, {
          status: 405,
          headers: { ...HEADERS, Allow: method },
        });
      if (
        !z.uuid().safeParse(projectId).success ||
        (requestId !== undefined && !z.uuid().safeParse(requestId).success) ||
        new URL(request.url).search
      )
        return failure(400, "Choose the exact project and creation request.");
      if (write && request.headers.get("origin") !== origin)
        return failure(
          403,
          "Open database creation from this Wrenly instance.",
        );
      const actor = await services.principal(request.headers);
      if (!actor)
        return failure(401, "Sign in before managing Production databases.");
      request.signal.throwIfAborted();
      if (write) {
        const parsed = ProductionProjectCreationInput.safeParse(
          await readDatabaseActionInput(request, MAX_CREATION_BYTES),
        );
        if (!parsed.success)
          return failure(
            400,
            "Review the creation request and current project revision.",
          );
        const input = parsed.data;
        const current = await services.principal(request.headers);
        if (
          !current ||
          current.userId !== actor.userId ||
          current.sessionId !== actor.sessionId ||
          current.revision !== actor.revision
        )
          return failure(
            401,
            "Your session changed. Sign in again before creating a database.",
          );
        request.signal.throwIfAborted();
        const receipt = ProductionProjectCreationReceipt.parse(
          await services.admit(actor, projectId, input),
        );
        return Response.json(receipt, {
          status: receipt.replayed ? 200 : 202,
          headers: HEADERS,
        });
      }
      const state = ProductionProjectCreationState.parse(
        await services.read(actor, projectId, requestId),
      );
      if (
        state.projectId !== projectId ||
        (requestId && state.creation && state.creation.requestId !== requestId)
      )
        throw new Error("Foreign creation status");
      const current = await services.principal(request.headers);
      if (
        !current ||
        current.userId !== actor.userId ||
        current.sessionId !== actor.sessionId ||
        current.revision !== actor.revision
      )
        return failure(
          401,
          "Your session changed. Sign in again before reading database status.",
        );
      request.signal.throwIfAborted();
      if (requestId && !state.creation)
        return failure(404, "Saved Production creation request not found.");
      return Response.json(state, { headers: HEADERS });
    } catch (error) {
      if (error instanceof DatabaseActionInputError)
        return failure(
          error.status,
          "Provide a bounded JSON creation request.",
        );
      if (
        error instanceof Error &&
        "status" in error &&
        typeof error.status === "number" &&
        [403, 404, 409, 429].includes(error.status)
      )
        return failure(
          error.status,
          "Production creation could not be accepted. Check project access, setup and existing work.",
        );
      return failure(
        503,
        "Production creation could not be confirmed. Check this request's saved status before trying again.",
      );
    }
  }
  async function recovery(
    request: Request,
    projectId: string,
  ): Promise<Response> {
    try {
      if (request.method !== "POST")
        return new Response(null, {
          status: 405,
          headers: { ...HEADERS, Allow: "POST" },
        });
      if (!z.uuid().safeParse(projectId).success || new URL(request.url).search)
        return failure(400, "Choose the exact project.");
      if (request.headers.get("origin") !== origin)
        return failure(403, "Open recovery from this Wrenly instance.");
      const actor = await services.principal(request.headers);
      if (!actor)
        return failure(401, "Sign in before reviewing Production setup.");
      const parsed = ProductionProjectRecoveryInput.safeParse(
        await readDatabaseActionInput(request, MAX_CREATION_BYTES),
      );
      if (!parsed.success)
        return failure(
          400,
          "Confirm the exact saved setup inspection or continuation.",
        );
      const current = await services.principal(request.headers);
      if (
        !current ||
        current.userId !== actor.userId ||
        current.sessionId !== actor.sessionId ||
        current.revision !== actor.revision
      )
        return failure(401, "Your session changed. Sign in again.");
      request.signal.throwIfAborted();
      if (!services.recover)
        return failure(503, "Production setup recovery is not enabled.");
      const saved = ProductionProjectRecoveryReceipt.parse(
        await services.recover(actor, projectId, parsed.data),
      );
      if (
        saved.kind !== parsed.data.kind ||
        (parsed.data.kind === "inspect" &&
          saved.kind === "inspect" &&
          saved.receipt.resourceId !== parsed.data.resourceId)
      )
        throw new Error("Foreign recovery receipt");
      return Response.json(saved, {
        status: saved.receipt.replayed ? 200 : 202,
        headers: HEADERS,
      });
    } catch (error) {
      if (error instanceof DatabaseActionInputError)
        return failure(error.status, "Provide a bounded recovery request.");
      const status =
        error instanceof Error && "status" in error ? error.status : undefined;
      if (typeof status === "number" && [403, 404, 409, 429].includes(status))
        return failure(
          status,
          "The saved recovery could not be accepted. Reload its status before reviewing again.",
        );
      return failure(
        503,
        "Recovery could not be confirmed. Keep this exact request and check its saved status before retrying.",
      );
    }
  }
  return {
    recovery,
    submit: (request, id) => handle(request, id, true),
    status: (request, id, requestId) => handle(request, id, false, requestId),
  };
}
