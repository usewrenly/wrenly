/** A bounded, trusted-origin completion endpoint; it cannot issue a recovery link. */
import { PasswordRecoveryError } from "./password-recovery-store";
const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_RECOVERIES = 4;
export function createPasswordRecoveryHandler(dependencies: {
  webUrl: string;
  complete: (input: unknown) => Promise<{ replayed: boolean }>;
}): (request: Request) => Promise<Response> {
  let active = 0;
  return async (request) => {
    const headers = {
      "Cache-Control": "no-store, private",
      "Referrer-Policy": "no-referrer",
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let admitted = false;
    try {
      if (request.headers.get("origin") !== new URL(dependencies.webUrl).origin)
        throw new PasswordRecoveryError(
          403,
          "Open recovery from this instance’s trusted web address.",
        );
      if (active >= MAX_CONCURRENT_RECOVERIES)
        return Response.json(
          { error: "Recovery is busy. Retry the same submission shortly." },
          { status: 429, headers },
        );
      active++;
      admitted = true;
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new PasswordRecoveryError(400, "Recovery requires JSON input.");
      reader = request.body?.getReader();
      if (!reader)
        throw new PasswordRecoveryError(400, "Recovery input is required.");
      let expired = false,
        size = 0;
      const chunks: Uint8Array[] = [];
      timer = setTimeout(() => {
        expired = true;
        void reader?.cancel().catch(() => {});
      }, BODY_TIMEOUT_MS);
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_BODY_BYTES)
          throw new PasswordRecoveryError(400, "Recovery input is too large.");
        chunks.push(next.value);
      }
      if (expired)
        throw new PasswordRecoveryError(400, "Recovery input timed out.");
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new PasswordRecoveryError(400, "Recovery input is invalid.");
      }
      return Response.json(
        { completed: true, ...(await dependencies.complete(input)) },
        { headers },
      );
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof PasswordRecoveryError
              ? error.message
              : "Recovery could not be confirmed. Retry the same submission.",
        },
        {
          status: error instanceof PasswordRecoveryError ? error.status : 503,
          headers,
        },
      );
    } finally {
      if (admitted) active--;
      if (timer) clearTimeout(timer);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  };
}
