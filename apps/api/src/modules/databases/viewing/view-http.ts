/**
 * COMPONENT: Database viewer HTTP boundary
 * PURPOSE: Serve explicit revision-bound reads to a currently signed-in browser.
 * INPUTS: Authenticated GET, project ID and bounded viewer query parameters.
 * OUTPUTS: Private no-store JSON or a safe refusal; no routes are mounted on import.
 * STEPS: Authenticate, validate exact query keys, authorize/query/recheck via the view
 * service, revalidate the live session, then return the bounded result.
 * EDGE CASES: Duplicate keys, unknown fields and stale/changed sessions fail closed.
 * ERROR STATES: Typed access/resource errors retain status; unknown failures are redacted.
 */
import { z } from "zod";
import { AppDatabaseError } from "../database-contract";
import {
  readAuthorizedDatabaseView,
  type DatabaseViewServices,
} from "./view-service";

const MAX_QUERY_BYTES = 2048;
const UUID = z.string().uuid();
const HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
const QUERY_KEYS = new Set([
  "resourceId",
  "revision",
  "environment",
  "rows",
  "table",
  "after",
]);

/** Production wiring must provide the complete fenced query adapter before mounting. */
export function createDatabaseViewHandler(
  services: DatabaseViewServices & {
    userId: (headers: Headers) => Promise<string | null>;
  },
): (request: Request, projectId: string) => Promise<Response> {
  return async (request, projectId): Promise<Response> => {
    try {
      const actor = await services.userId(request.headers);
      if (!actor)
        return Response.json(
          { error: "Sign in to inspect this project's database." },
          { status: 401, headers: HEADERS },
        );
      if (request.method !== "GET")
        return Response.json(
          { error: "Use GET to inspect database data." },
          { status: 405, headers: { ...HEADERS, Allow: "GET" } },
        );
      const url = new URL(request.url);
      if (
        !UUID.safeParse(projectId).success ||
        Buffer.byteLength(url.search) > MAX_QUERY_BYTES
      )
        throw new AppDatabaseError(
          400,
          "Choose a valid project and bounded database view.",
        );
      const values: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (!QUERY_KEYS.has(key) || Object.hasOwn(values, key))
          throw new AppDatabaseError(
            400,
            "Database view parameters must be explicit and unique.",
          );
        values[key] = value;
      }
      if (values.rows !== "true" && values.rows !== "false")
        throw new AppDatabaseError(
          400,
          "Choose schema-only or row viewing explicitly.",
        );
      const result = await readAuthorizedDatabaseView(
        services,
        projectId,
        actor,
        { ...values, rows: values.rows === "true" },
        request.signal,
      );
      if ((await services.userId(request.headers)) !== actor)
        return Response.json(
          {
            error:
              "Your session changed. Sign in again before inspecting data.",
          },
          { status: 401, headers: HEADERS },
        );
      request.signal.throwIfAborted();
      return Response.json(result, { headers: HEADERS });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof AppDatabaseError
              ? error.message
              : "Database view could not be loaded. Reload its current status.",
        },
        {
          status: error instanceof AppDatabaseError ? error.status : 503,
          headers: HEADERS,
        },
      );
    }
  };
}
