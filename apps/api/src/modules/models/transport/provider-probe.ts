/**
 * Read-only model-list transport.
 * Pins validated resolved destinations, scopes authentication and rejects redirects under byte/deadline limits.
 * Safe errors distinguish unavailable lists from inference capability; probes never execute model instructions.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  resolveProviderDestination,
  ProviderDestinationError,
  type ProviderLookup,
} from "./provider-destination";
const PROBE_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10_000;
export type ProviderProbeCategory =
  | "authentication"
  | "network"
  | "timeout"
  | "redirect"
  | "invalid-response"
  | "response-too-large"
  | "model-list-unavailable"
  | "destination";
export class ProviderProbeError extends Error {
  constructor(
    public readonly category: ProviderProbeCategory,
    message: string,
  ) {
    super(message);
    this.name = "ProviderProbeError";
  }
}
/** Reads one model-list endpoint using a validated pinned address; original hostname still governs Host/TLS validation. */
export async function readProviderModelList(
  input: {
    endpoint: string;
    kind: "local" | "cloud";
    protocol: "ollama" | "openai-compatible";
    token: string | null;
  },
  signal?: AbortSignal,
  resolver?: ProviderLookup,
): Promise<unknown> {
  try {
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS);
    deadline.throwIfAborted();
    const destination = await resolveProviderDestination(
      input.endpoint,
      input.kind,
      resolver,
      deadline,
    );
    deadline.throwIfAborted();
    const url = new URL(
      destination.url.href.replace(/\/+$/, "") +
        (input.protocol === "ollama" ? "/api/tags" : "/models"),
    );
    return await new Promise<unknown>((resolve, reject) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (input.token) headers.Authorization = `Bearer ${input.token}`;
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          headers,
          agent: false,
          family: destination.family,
          lookup: (_hostname, options, callback) => {
            if (options.all)
              callback(null, [
                { address: destination.address, family: destination.family },
              ]);
            else callback(null, destination.address, destination.family);
          },
          signal: deadline,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const fail = (
            category: ProviderProbeCategory,
            message: string,
          ): void => {
            response.destroy();
            reject(new ProviderProbeError(category, message));
          };
          if (status >= 300 && status < 400)
            return fail(
              "redirect",
              "The provider redirected its model-list request. Check the configured address; credentials were not forwarded.",
            );
          if (status === 401 || status === 403)
            return fail(
              "authentication",
              "The provider rejected this token. Check its value and account permissions.",
            );
          if (status < 200 || status >= 300)
            return fail(
              "model-list-unavailable",
              "This endpoint did not provide a usable model list. Check its address or select a catalog model explicitly.",
            );
          const length = response.headers["content-length"];
          if (
            length &&
            (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
          )
            return fail(
              "response-too-large",
              "The provider model list exceeds the supported size.",
            );
          if (
            !response.headers["content-type"]
              ?.toLowerCase()
              .includes("application/json")
          )
            return fail(
              "invalid-response",
              "The provider returned an unsupported model-list response.",
            );
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              fail(
                "response-too-large",
                "The provider model list exceeds the supported size.",
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            try {
              resolve(
                JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
              );
            } catch {
              reject(
                new ProviderProbeError(
                  "invalid-response",
                  "The provider model-list response could not be read.",
                ),
              );
            }
          });
          response.once("error", () =>
            reject(
              new ProviderProbeError(
                deadline.aborted ? "timeout" : "network",
                "The provider connection ended before its model list was received.",
              ),
            ),
          );
        },
      );
      request.once("error", () =>
        reject(
          new ProviderProbeError(
            deadline.aborted ? "timeout" : "network",
            deadline.aborted
              ? "The provider connection check timed out or was cancelled."
              : "The provider could not be reached. Check its service and address.",
          ),
        ),
      );
      request.end();
    });
  } catch (error) {
    if (error instanceof ProviderProbeError) throw error;
    if (error instanceof ProviderDestinationError)
      throw new ProviderProbeError(
        error.message.includes("timed out") ? "timeout" : "destination",
        error.message,
      );
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      throw new ProviderProbeError(
        "timeout",
        "The provider connection check timed out or was cancelled.",
      );
    throw new ProviderProbeError(
      "network",
      "The provider connection could not be checked. Check its service and address.",
    );
  }
}
/** Distinguishes a healthy empty service from malformed or unreachable model discovery. */
export function parseProviderModels(
  raw: unknown,
  protocol: "ollama" | "openai-compatible",
): { state: "ready" | "empty"; models: string[] } {
  if (!raw || typeof raw !== "object")
    throw new ProviderProbeError(
      "invalid-response",
      "The provider did not return a model list.",
    );
  const entries =
    protocol === "ollama"
      ? "models" in raw
        ? raw.models
        : undefined
      : "data" in raw
        ? raw.data
        : undefined;
  if (!Array.isArray(entries) || entries.length > MAX_MODELS)
    throw new ProviderProbeError(
      "invalid-response",
      "The provider model list has an unsupported format or size.",
    );
  const models = entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object")
      throw new ProviderProbeError(
        "invalid-response",
        "The provider model list contains an invalid entry.",
      );
    const id =
      protocol === "ollama"
        ? "name" in entry
          ? entry.name
          : undefined
        : "id" in entry
          ? entry.id
          : undefined;
    if (typeof id !== "string" || !id.length || id.length > 512)
      throw new ProviderProbeError(
        "invalid-response",
        "The provider model list contains an invalid model identity.",
      );
    return id;
  });
  return {
    state: models.length ? "ready" : "empty",
    models: [...new Set(models)].sort(),
  };
}
