/**
 * Owner provider-configuration HTTP boundary.
 * Authenticates before bounded input parsing and checks trusted origins for writes/probes.
 * Safe responses omit tokens and encryption material; unknown acknowledgements retain explicit retry identity.
 */
import { ProviderConnectionError } from "./provider-connection-store";
import { ProviderDestinationError } from "../transport/provider-destination";
import type { ProviderConfigurationService } from "./provider-configuration-service";
const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 5000;
const HEADERS = { "Cache-Control": "no-store, private" };
type Action = "list" | "create" | "update" | "probe" | "saveDefault";
export type ProviderConfigurationHandlers = Record<
  Action,
  (request: Request) => Promise<Response>
>;
async function readInput(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new ProviderConnectionError(400, "Send JSON provider settings.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new ProviderConnectionError(400, "Provider settings are required.");
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, BODY_TIMEOUT_MS);
  try {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > MAX_BODY_BYTES)
        throw new ProviderConnectionError(
          400,
          "Provider settings exceed the supported size.",
        );
      chunks.push(next.value);
    }
    if (expired)
      throw new ProviderConnectionError(
        400,
        "Provider settings request timed out.",
      );
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ProviderConnectionError(
        400,
        "Provider settings contain invalid JSON.",
      );
    }
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Connects authenticated, bounded same-origin requests to the owner-only provider service. */
export function createProviderConfigurationHandlers(dependencies: {
  webUrl: string;
  session: (headers: Headers) => Promise<string | null>;
  service: ProviderConfigurationService;
}): ProviderConfigurationHandlers {
  const handler =
    (action: Action) =>
    async (request: Request): Promise<Response> => {
      try {
        if (
          action !== "list" &&
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          return Response.json(
            {
              error:
                "Open provider configuration from the trusted web address.",
            },
            { status: 403, headers: HEADERS },
          );
        const actorId = await dependencies.session(request.headers);
        if (!actorId)
          return Response.json(
            { error: "Sign in to manage model providers." },
            { status: 401, headers: HEADERS },
          );
        const input = action === "list" ? undefined : await readInput(request);
        let result: unknown;
        if (action === "list")
          result = await dependencies.service.list(actorId);
        else if (action === "probe")
          result = await dependencies.service.probe(
            actorId,
            input,
            request.signal,
          );
        else {
          result = await dependencies.service[action](actorId, input);
          if (result === undefined) result = { saved: true };
        }
        return Response.json(result, { headers: HEADERS });
      } catch (error) {
        if (error instanceof ProviderConnectionError)
          return Response.json(
            { error: error.message },
            { status: error.status, headers: HEADERS },
          );
        if (error instanceof ProviderDestinationError)
          return Response.json(
            { error: error.message },
            { status: 400, headers: HEADERS },
          );
        return Response.json(
          { error: "Provider configuration is unavailable. Try again." },
          { status: 503, headers: HEADERS },
        );
      }
    };
  return {
    list: handler("list"),
    create: handler("create"),
    update: handler("update"),
    probe: handler("probe"),
    saveDefault: handler("saveDefault"),
  };
}
