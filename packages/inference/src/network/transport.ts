/**
 * Bounded non-streaming inference Fetch adapter.
 * API conversations and framework MCP servers use this native transport to pin checked DNS, filter headers and refuse redirects.
 * Request/response bytes and total time are bounded; errors never expose prompts, credentials or upstream diagnostic bodies.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveProviderDestination, type ProviderLookup } from "./destination";
// Source context and model output need room, but buffering must have a fixed memory ceiling.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Generation can be slow; the upper bound prevents configuration from creating unbounded sockets.
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
export class InferenceTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceTransportError";
  }
}
async function readRequestBody(
  request: Request,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new InferenceTransportError("Inference request is empty.");
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES)
        throw new InferenceTransportError(
          "Inference request exceeds its supported size.",
        );
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    if (!bytes)
      throw new InferenceTransportError("Inference request is empty.");
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
/** Creates a non-streaming SDK-compatible transport pinned to one configured inference endpoint. */
export function createInferenceFetch(
  configuration: {
    baseUrl: string;
    kind: "local" | "cloud";
    timeoutMs?: number;
  },
  resolver?: ProviderLookup,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const base = new URL(configuration.baseUrl.replace(/\/+$/, "") + "/");
  const timeoutMs = configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw new InferenceTransportError("Inference timeout is invalid.");
  return async (input, init) => {
    try {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== base.origin ||
        url.pathname !== base.pathname + "chat/completions" ||
        url.search ||
        url.hash ||
        request.method !== "POST"
      )
        throw new InferenceTransportError(
          "Inference request does not match the configured provider endpoint.",
        );
      const signal = AbortSignal.any([
        request.signal,
        init?.signal ?? new AbortController().signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      signal.throwIfAborted();
      const destination = await resolveProviderDestination(
        base.href,
        configuration.kind,
        resolver,
        signal,
      ).catch((error: unknown) => {
        if (signal.aborted)
          throw new InferenceTransportError(
            "Inference was cancelled or reached its deadline.",
          );
        throw error;
      });
      signal.throwIfAborted();
      const body = await readRequestBody(request, signal);
      if (!body.byteLength || body.byteLength > MAX_REQUEST_BYTES)
        throw new InferenceTransportError(
          "Inference request exceeds its supported size.",
        );
      const payload: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
      if (
        !payload ||
        typeof payload !== "object" ||
        ("stream" in payload && payload.stream === true)
      )
        throw new InferenceTransportError(
          "Streaming inference is not enabled for this transport.",
        );
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      const authorization = request.headers.get("authorization");
      if (authorization) headers.Authorization = authorization;
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(
          url,
          {
            method: "POST",
            headers,
            agent: false,
            family: destination.family,
            signal,
            lookup: (_host, options, callback) => {
              if (options.all)
                callback(null, [
                  { address: destination.address, family: destination.family },
                ]);
              else callback(null, destination.address, destination.family);
            },
          },
          (response) => {
            const status = response.statusCode ?? 502;
            const fail = (message: string): void => {
              response.destroy();
              reject(new InferenceTransportError(message));
            };
            if (status >= 300 && status < 400)
              return fail(
                "The inference provider redirected the request. Check its configured endpoint.",
              );
            if (status < 200 || status >= 300) {
              response.destroy();
              resolve(
                Response.json(
                  {
                    error: {
                      message:
                        "The model provider rejected the inference request.",
                      type: "provider_error",
                    },
                  },
                  { status: status >= 400 && status <= 599 ? status : 502 },
                ),
              );
              return;
            }
            if (
              !response.headers["content-type"]
                ?.toLowerCase()
                .includes("application/json")
            )
              return fail(
                "The inference provider returned an unsupported response.",
              );
            const length = response.headers["content-length"];
            if (
              length &&
              (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
            )
              return fail("The inference response exceeds its supported size.");
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE_BYTES) {
                fail("The inference response exceeds its supported size.");
                return;
              }
              chunks.push(chunk);
            });
            response.once("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status,
                  headers: { "Content-Type": "application/json" },
                }),
              ),
            );
            response.once("error", () =>
              reject(
                new InferenceTransportError(
                  signal.aborted
                    ? "Inference was cancelled or reached its deadline."
                    : "The inference response ended before completion.",
                ),
              ),
            );
          },
        );
        outgoing.once("error", () =>
          reject(
            new InferenceTransportError(
              signal.aborted
                ? "Inference was cancelled or reached its deadline."
                : "The inference provider could not be reached.",
            ),
          ),
        );
        outgoing.end(Buffer.from(body));
      });
    } catch (error) {
      if (error instanceof InferenceTransportError) throw error;
      throw new InferenceTransportError(
        "The inference request could not be validated or completed.",
      );
    }
  };
}
