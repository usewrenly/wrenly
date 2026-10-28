/**
 * Deployment provider HTTP transport
 * Used by Gitea and Coolify adapters called by the durable API executor.
 * Pins authentication to one configured origin, rejects redirects and bounds request/response work.
 * Returns parsed unknown data for provider-specific validation; never retries mutations or exposes remote bodies.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKEN_CHARACTERS = 16_000;
const MAX_ENDPOINT_CHARACTERS = 2_048;
const PROVIDER_API_PREFIX = "/api/v1/";

type FailureCode =
  | "invalid_configuration"
  | "invalid_endpoint"
  | "request_too_large"
  | "request_failed"
  | "timeout"
  | "cancelled"
  | "response_too_large"
  | "invalid_response"
  | "http_error";
export class DeploymentProviderError extends Error {
  constructor(
    public readonly code: FailureCode,
    public readonly status?: number,
  ) {
    super(`Deployment provider request failed (${code}).`);
    this.name = "DeploymentProviderError";
  }
}
export interface DeploymentProviderClient {
  request: (
    method: "GET" | "POST" | "PATCH",
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/** Bounds even injected transports that do not settle when their signal aborts. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new DeploymentProviderError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Creates a fixed-origin, credential-filtered JSON client; mutations are never retried. */
export function createDeploymentProviderClient(
  configuration: {
    origin: string;
    token: string;
    authentication: "token" | "Bearer";
    timeoutMs?: number;
  },
  transport: typeof fetch = fetch,
): DeploymentProviderClient {
  let origin: URL;
  try {
    origin = new URL(configuration.origin);
  } catch {
    throw new DeploymentProviderError("invalid_configuration");
  }
  const timeoutMs = configuration.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !configuration.token ||
    configuration.token.length > MAX_TOKEN_CHARACTERS ||
    /[\r\n]/.test(configuration.token) ||
    !["token", "Bearer"].includes(configuration.authentication) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > REQUEST_TIMEOUT_MS
  )
    throw new DeploymentProviderError("invalid_configuration");
  return {
    async request(method, endpoint, body, externalSignal): Promise<unknown> {
      if (
        !endpoint.startsWith(PROVIDER_API_PREFIX) ||
        endpoint.length > MAX_ENDPOINT_CHARACTERS ||
        /[\\#\x00-\x20\x7f]/.test(endpoint)
      )
        throw new DeploymentProviderError("invalid_endpoint");
      let url: URL;
      try {
        url = new URL(endpoint, origin);
        if (
          url.origin !== origin.origin ||
          !url.pathname.startsWith(PROVIDER_API_PREFIX) ||
          endpoint
            .split("?")[0]!
            .split("/")
            .some(
              (segment) =>
                [".", ".."].includes(decodeURIComponent(segment)) ||
                /[\\/]/.test(decodeURIComponent(segment)),
            )
        )
          throw new Error("Invalid endpoint");
      } catch {
        throw new DeploymentProviderError("invalid_endpoint");
      }
      let serialized: string | undefined;
      try {
        serialized = body === undefined ? undefined : JSON.stringify(body);
      } catch {
        throw new DeploymentProviderError("request_too_large");
      }
      if (serialized && Buffer.byteLength(serialized) > MAX_REQUEST_BYTES)
        throw new DeploymentProviderError("request_too_large");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const abort = (): void => controller.abort();
      externalSignal?.addEventListener("abort", abort, { once: true });
      if (externalSignal?.aborted) abort();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      const cancelReader = (): void => {
        void reader?.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      try {
        controller.signal.throwIfAborted();
        const pending = transport(url, {
          method,
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
          headers: {
            Authorization: `${configuration.authentication} ${configuration.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: serialized,
        });
        void pending.then(
          (value) => {
            if (controller.signal.aborted)
              void value.body?.cancel().catch(() => {});
          },
          () => {},
        );
        response = await withAbort(pending, controller.signal);
        if (!response.ok)
          throw new DeploymentProviderError("http_error", response.status);
        const length = response.headers.get("content-length");
        if (length && Number(length) > MAX_RESPONSE_BYTES)
          throw new DeploymentProviderError("response_too_large");
        if (!response.body)
          throw new DeploymentProviderError("invalid_response");
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let text = "";
        while (true) {
          const chunk = await withAbort(reader.read(), controller.signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES)
            throw new DeploymentProviderError("response_too_large");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        controller.signal.throwIfAborted();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new DeploymentProviderError("invalid_response");
        }
      } catch (error) {
        if (timedOut) throw new DeploymentProviderError("timeout");
        if (controller.signal.aborted)
          throw new DeploymentProviderError("cancelled");
        if (error instanceof DeploymentProviderError) throw error;
        throw new DeploymentProviderError("request_failed");
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", cancelReader);
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        } else {
          void response?.body?.cancel().catch(() => {});
        }
        controller.abort();
      }
    },
  };
}
