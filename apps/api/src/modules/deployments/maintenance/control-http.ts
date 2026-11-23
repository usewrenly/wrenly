/** Bounded current-owner transport; looking up a saved control never performs host work. */
import { z } from "zod";
import {
  MaintenanceControl,
  MaintenanceControlReceipt,
} from "@wrenly/db/production-maintenance-contract";
import type { AccessPrincipal } from "../../auth/access/access-context";
import {
  readDatabaseActionInput,
  DatabaseActionInputError,
} from "../../databases/http/action-input";
import { DeploymentStoreError } from "../persistence/deployment-store";
const MAX_CONTROL_BYTES = 2048;
const HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
export interface OwnerRuntimeControlHandlers {
  get: (
    request: Request,
    projectId: string,
    deploymentId: string,
    requestId: string,
  ) => Promise<Response>;
  save: (
    request: Request,
    projectId: string,
    deploymentId: string,
  ) => Promise<Response>;
}
/** Execution owns an independent deadline after admission; browser disconnects retain the saved control result. */
export function createOwnerRuntimeControlHandlers(
  services: {
    principal: (headers: Headers) => Promise<AccessPrincipal | null>;
    read: (
      actor: AccessPrincipal,
      projectId: string,
      deploymentId: string,
      requestId: string,
    ) => Promise<MaintenanceControlReceipt | null>;
    save: (
      actor: AccessPrincipal,
      projectId: string,
      deploymentId: string,
      action: MaintenanceControl,
    ) => Promise<MaintenanceControlReceipt>;
  },
  webUrl: string,
): OwnerRuntimeControlHandlers {
  const origin = new URL(webUrl).origin;
  async function run(
    request: Request,
    projectId: string,
    deploymentId: string,
    requestId?: string,
  ): Promise<Response> {
    const fail = (status: number, error: string): Response =>
      Response.json({ error }, { status, headers: HEADERS });
    try {
      if (request.method !== (requestId ? "GET" : "POST"))
        return fail(405, "Unsupported runtime control request.");
      if (
        ![projectId, deploymentId, ...(requestId ? [requestId] : [])].every(
          (id) => z.uuid().safeParse(id).success,
        ) ||
        new URL(request.url).search
      )
        return fail(400, "Choose a valid publication and saved action.");
      if (!requestId && request.headers.get("origin") !== origin)
        return fail(403, "Open runtime controls from this Wrenly instance.");
      const actor = await services.principal(request.headers);
      if (!actor) return fail(401, "Sign in to review this publication.");
      request.signal.throwIfAborted();
      const value = requestId
        ? await services.read(actor, projectId, deploymentId, requestId)
        : await services.save(
            actor,
            projectId,
            deploymentId,
            MaintenanceControl.parse(
              await readDatabaseActionInput(request, MAX_CONTROL_BYTES),
            ),
          );
      if (!value) return fail(404, "Saved runtime control not found.");
      const current = await services.principal(request.headers);
      if (
        !current ||
        current.userId !== actor.userId ||
        current.sessionId !== actor.sessionId ||
        current.revision !== actor.revision
      )
        return fail(
          401,
          "Your session changed. Sign in and check the saved action.",
        );
      return Response.json(MaintenanceControlReceipt.parse(value), {
        headers: HEADERS,
      });
    } catch (error) {
      if (
        error instanceof DatabaseActionInputError ||
        error instanceof DeploymentStoreError
      )
        return fail(error.status, error.message);
      if (error instanceof z.ZodError)
        return fail(
          400,
          "Review the current publication before confirming runtime control.",
        );
      return fail(
        503,
        "Runtime control could not be confirmed. Check its saved action before trying again.",
      );
    }
  }
  return {
    get: (request, projectId, deploymentId, requestId) =>
      run(request, projectId, deploymentId, requestId),
    save: (request, projectId, deploymentId) =>
      run(request, projectId, deploymentId),
  };
}
