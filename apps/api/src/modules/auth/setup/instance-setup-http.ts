/**
 * First-owner HTTP boundary.
 * Public reads reveal only setup state.
 * Account creation requires a bounded credential body and operator proof; successful setup does not return a session token or bypass ordinary sign-in.
 */
import {
  InstanceSetupError,
  type InstanceSetupStatus,
} from "./instance-setup-store";
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 5000;
export interface InstanceSetupHandlers {
  status: (request: Request) => Promise<Response>;
  create: (request: Request) => Promise<Response>;
}

/** Binds bounded browser setup requests to the proof-fenced initialization service. */
export function createInstanceSetupHandlers(dependencies: {
  webUrl: string;
  status: () => Promise<InstanceSetupStatus>;
  claim: (input: unknown) => Promise<{ replayed: boolean }>;
}): InstanceSetupHandlers {
  const headers = { "Cache-Control": "no-store, private" };
  const failure = (error: unknown): Response =>
    error instanceof InstanceSetupError
      ? Response.json(
          { error: error.message },
          { status: error.status, headers },
        )
      : Response.json(
          { error: "Instance setup could not be checked. Try again." },
          { status: 503, headers },
        );
  return {
    status: async () => {
      try {
        return Response.json(
          { status: await dependencies.status() },
          { headers },
        );
      } catch (error) {
        return failure(error);
      }
    },
    create: async (request) => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (
          request.headers.get("origin") !== new URL(dependencies.webUrl).origin
        )
          throw new InstanceSetupError(
            403,
            "Open setup from this instance’s trusted web address.",
          );
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new InstanceSetupError(400, "Setup requires JSON input.");
        reader = request.body?.getReader();
        if (!reader)
          throw new InstanceSetupError(400, "Setup input is required.");
        let expired = false;
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        timeout = setTimeout(() => {
          expired = true;
          void reader?.cancel().catch(() => {});
        }, BODY_TIMEOUT_MS);
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > MAX_BODY_BYTES)
            throw new InstanceSetupError(400, "Setup input is too large.");
          chunks.push(next.value);
        }
        if (expired)
          throw new InstanceSetupError(400, "Setup request timed out.");
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new InstanceSetupError(400, "Setup input is invalid.");
        }
        return Response.json(
          { created: true, ...(await dependencies.claim(input)) },
          { status: 201, headers },
        );
      } catch (error) {
        return failure(error);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  };
}
