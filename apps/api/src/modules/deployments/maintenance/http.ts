/** Bounded owner transport. Reads and lost-response receipt checks cannot start maintenance. */
import { z } from "zod";
import {
  MaintenanceDecision,
  MaintenanceDecisionReceipt,
  MaintenanceView,
} from "@wrenly/db/production-maintenance-contract";
import type { AccessPrincipal } from "../../auth/access/access-context";
import {
  readDatabaseActionInput,
  DatabaseActionInputError,
} from "../../databases/http/action-input";
import { DeploymentStoreError } from "../persistence/deployment-store";
const HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
const MAX_DECISION_BYTES = 2048;
export interface MaintenanceHttpHandlers {
  get: (
    request: Request,
    projectId: string,
    deploymentId: string,
    requestId?: string,
  ) => Promise<Response>;
  save: (
    request: Request,
    projectId: string,
    deploymentId: string,
  ) => Promise<Response>;
}
export function createMaintenanceHttpHandlers(
  services: {
    principal: (headers: Headers) => Promise<AccessPrincipal | null>;
    read: (
      actor: AccessPrincipal,
      projectId: string,
      deploymentId: string,
      requestId?: string,
    ) => Promise<unknown>;
    save: (
      actor: AccessPrincipal,
      projectId: string,
      deploymentId: string,
      decision: MaintenanceDecision,
    ) => Promise<MaintenanceDecisionReceipt>;
  },
  webUrl: string,
): MaintenanceHttpHandlers {
  const origin = new URL(webUrl).origin;
  async function run(
    request: Request,
    projectId: string,
    deploymentId: string,
    write: boolean,
    requestId?: string,
  ): Promise<Response> {
    const fail = (status: number, error: string): Response =>
      Response.json({ error }, { status, headers: HEADERS });
    try {
      if (request.method !== (write ? "POST" : "GET"))
        return fail(405, "Unsupported maintenance request.");
      if (
        !z.uuid().safeParse(projectId).success ||
        !z.uuid().safeParse(deploymentId).success ||
        (requestId !== undefined && !z.uuid().safeParse(requestId).success) ||
        new URL(request.url).search
      )
        return fail(400, "Choose a valid publication or saved decision.");
      if (write && request.headers.get("origin") !== origin)
        return fail(
          403,
          "Open maintenance controls from this Wrenly instance.",
        );
      const actor = await services.principal(request.headers);
      if (!actor) return fail(401, "Sign in to review maintenance permission.");
      request.signal.throwIfAborted();
      const value = write
        ? MaintenanceDecisionReceipt.parse(
            await services.save(
              actor,
              projectId,
              deploymentId,
              MaintenanceDecision.parse(
                await readDatabaseActionInput(request, MAX_DECISION_BYTES),
              ),
            ),
          )
        : await services.read(actor, projectId, deploymentId, requestId);
      if (value === null)
        return fail(404, "Saved maintenance decision not found.");
      const parsed = (
        write || requestId ? MaintenanceDecisionReceipt : MaintenanceView
      ).safeParse(value);
      if (!parsed.success)
        return fail(503, "Saved maintenance state could not be verified.");
      const current = await services.principal(request.headers);
      if (
        !current ||
        current.userId !== actor.userId ||
        current.sessionId !== actor.sessionId ||
        current.revision !== actor.revision
      )
        return fail(
          401,
          "Your session changed. Sign in and check the saved decision.",
        );
      request.signal.throwIfAborted();
      return Response.json(parsed.data, { headers: HEADERS });
    } catch (error) {
      if (error instanceof DatabaseActionInputError)
        return fail(error.status, error.message);
      if (error instanceof DeploymentStoreError)
        return fail(error.status, error.message);
      if (error instanceof z.ZodError)
        return fail(400, "Maintenance values could not be verified.");
      return fail(
        503,
        "Maintenance could not be confirmed. Check the saved decision before trying again.",
      );
    }
  }
  return {
    get: (request, projectId, deploymentId, requestId) =>
      run(request, projectId, deploymentId, false, requestId),
    save: (request, projectId, deploymentId) =>
      run(request, projectId, deploymentId, true),
  };
}
