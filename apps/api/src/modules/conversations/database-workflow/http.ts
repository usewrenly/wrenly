/** Narrow owner approval boundary; HTTP reads never advance a workflow. */
import { z } from "zod";
import type { db } from "@wrenly/db";
import { readDatabaseActionInput } from "../../databases/http/action-input";
import { approveDatabaseWorkflow, readDatabaseWorkflows } from "./store";
const UUID = z.string().uuid();
const HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
export interface DatabaseWorkflowHandlers {
  read: (request: Request, projectId: string) => Promise<Response>;
  approve: (
    request: Request,
    projectId: string,
    id: string,
  ) => Promise<Response>;
}
/** Current Better Auth identity is captured before each owner transaction. */
export function createDatabaseWorkflowHandlers(
  database: typeof db,
  userId: (headers: Headers) => Promise<string | null>,
  webUrl: string,
): DatabaseWorkflowHandlers {
  const handle = async (
    request: Request,
    projectId: string,
    id?: string,
  ): Promise<Response> => {
    try {
      const actor = await userId(request.headers);
      if (!actor)
        return Response.json(
          { error: "Sign in to view this conversation." },
          { status: 401, headers: HEADERS },
        );
      if (
        !UUID.safeParse(projectId).success ||
        (id !== undefined && !UUID.safeParse(id).success) ||
        new URL(request.url).search
      )
        return Response.json(
          { error: "Choose a saved project and proposal." },
          { status: 400, headers: HEADERS },
        );
      if (request.method !== (id ? "POST" : "GET"))
        return Response.json(
          { error: "Unsupported method." },
          { status: 405, headers: HEADERS },
        );
      if (id) {
        if (request.headers.get("origin") !== new URL(webUrl).origin)
          return Response.json(
            { error: "Use this instance to approve database work." },
            { status: 403, headers: HEADERS },
          );
        const body = await readDatabaseActionInput(request);
        if ((await userId(request.headers)) !== actor)
          return Response.json(
            { error: "Sign in again." },
            { status: 401, headers: HEADERS },
          );
        await approveDatabaseWorkflow(database, projectId, actor, id, body);
      }
      const result = await readDatabaseWorkflows(database, projectId, actor);
      if ((await userId(request.headers)) !== actor)
        return Response.json(
          { error: "Sign in again." },
          { status: 401, headers: HEADERS },
        );
      return Response.json(result, { headers: HEADERS });
    } catch (error) {
      const status =
        error instanceof z.ZodError
          ? 400
          : error instanceof Error &&
              "status" in error &&
              typeof error.status === "number" &&
              [400, 403, 404, 409, 429].includes(error.status)
            ? error.status
            : 503;
      return Response.json(
        {
          error:
            status === 409
              ? "The proposal or project changed. Reload the card before reviewing again."
              : status === 403
                ? "Only the project owner can approve database work."
                : "Database workflow could not be confirmed. Reload its saved status before trying again.",
        },
        { status, headers: HEADERS },
      );
    }
  };
  return {
    read: (request, project) => handle(request, project),
    approve: (request, project, id) => handle(request, project, id),
  };
}
