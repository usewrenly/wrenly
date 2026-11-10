/** One-time instance setup transport; construction starts no listener, check or worker. */
import { z } from "zod";
import {
  ProductionConnectionInput,
  ProductionConnectionReceipt,
  ProductionConnectionState,
  ProductionConnectionAcknowledgement,
} from "@wrenly/db/production-connection-contract";
import type { AccessPrincipal } from "../../../auth/access/access-context";
import { readDatabaseActionInput } from "../../http/action-input";
const UUID = z.uuid();
const MAX_BODY_BYTES = 24 * 1024;
const HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
export interface InstanceProductionHttpServices {
  principal: (headers: Headers) => Promise<AccessPrincipal | null>;
  admit: (
    principal: AccessPrincipal,
    input: ProductionConnectionInput,
  ) => Promise<unknown>;
  read: (principal: AccessPrincipal, requestId?: string) => Promise<unknown>;
  acknowledge: (
    principal: AccessPrincipal,
    connectionId: string,
  ) => Promise<unknown>;
}
export interface InstanceProductionHttpHandlers {
  submit: (request: Request) => Promise<Response>;
  status: (request: Request, requestId?: string) => Promise<Response>;
  acknowledge: (request: Request) => Promise<Response>;
}
/** Store methods independently require the current instance owner; no browser field selects the acting account. */
export function createInstanceProductionHttpHandlers(
  services: InstanceProductionHttpServices,
  webUrl: string,
): InstanceProductionHttpHandlers {
  const origin = new URL(webUrl).origin;
  const fail = (status: number, error: string): Response =>
    Response.json({ error }, { status, headers: HEADERS });
  async function run(
    request: Request,
    action: "submit" | "status" | "acknowledge",
    requestId?: string,
  ): Promise<Response> {
    try {
      const method = action === "status" ? "GET" : "POST";
      if (request.method !== method)
        return new Response(null, {
          status: 405,
          headers: { ...HEADERS, Allow: method },
        });
      if (
        new URL(request.url).search ||
        (requestId !== undefined && !UUID.safeParse(requestId).success)
      )
        return fail(400, "Choose a valid connection request.");
      if (action !== "status" && request.headers.get("origin") !== origin)
        return fail(403, "Open database setup from this Wrenly instance.");
      const principal = await services.principal(request.headers);
      if (!principal)
        return fail(401, "Sign in before configuring Production databases.");
      request.signal.throwIfAborted();
      let value: unknown;
      if (action === "status") {
        const state = await services.read(principal, requestId);
        if (state === null && requestId !== undefined)
          return fail(404, "Connection request not found.");
        const parsed = ProductionConnectionState.nullable().safeParse(state);
        if (!parsed.success)
          return fail(503, "Saved connection status could not be verified.");
        value = parsed.data;
      } else {
        const body = await readDatabaseActionInput(request, MAX_BODY_BYTES);
        const receipt = await (action === "submit"
          ? services.admit(principal, ProductionConnectionInput.parse(body))
          : services.acknowledge(
              principal,
              ProductionConnectionAcknowledgement.parse(body).connectionId,
            ));
        const parsed = ProductionConnectionReceipt.safeParse(receipt);
        if (!parsed.success)
          return fail(
            503,
            "The saved connection receipt could not be verified. Check its status.",
          );
        value = parsed.data;
      }
      const current = await services.principal(request.headers);
      if (
        !current ||
        current.userId !== principal.userId ||
        current.sessionId !== principal.sessionId ||
        current.revision !== principal.revision
      )
        return fail(
          401,
          "Your session changed. Sign in and check the saved connection request.",
        );
      request.signal.throwIfAborted();
      return Response.json(value, {
        status:
          action === "submit" &&
          value !== null &&
          ProductionConnectionReceipt.parse(value).replayed === false
            ? 202
            : 200,
        headers: HEADERS,
      });
    } catch (error) {
      if (error instanceof z.ZodError)
        return fail(
          400,
          "Review the connection fields and explicit confirmation.",
        );
      const status =
        error instanceof Error && "status" in error ? error.status : undefined;
      if (status === 403 || status === 404)
        return fail(
          status,
          "Production server configuration requires the instance owner.",
        );
      if (status === 409)
        return fail(
          409,
          "Configuration changed or work is still active. Check the saved request first.",
        );
      if (status === 429)
        return fail(429, "Connection checks are busy. Try again shortly.");
      if (status === 400 || status === 408 || status === 413 || status === 415)
        return fail(status, "Send a bounded JSON connection request.");
      return fail(
        503,
        "The connection result could not be confirmed. Check its saved request before retrying.",
      );
    }
  }
  return {
    submit: (request) => run(request, "submit"),
    status: (request, requestId) => run(request, "status", requestId),
    acknowledge: (request) => run(request, "acknowledge"),
  };
}
