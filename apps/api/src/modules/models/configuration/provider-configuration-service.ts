/**
 * Provider configuration coordination.
 * Verifies owner authority before persistence or network work, binds catalog/environment revisions to reviewed destinations and delegates encrypted storage.
 * Probes are explicit read-only model checks, never inference or registry installation.
 */
import type { EnvironmentProviderMetadata } from "../environment/environment-providers";
import { z } from "zod";
import { logger } from "../../../lib/logger";
import { ProviderDestinationError } from "../transport/provider-destination";
import type { AvailableCatalog } from "../catalog/provider-catalog-store";
import {
  ProviderConnectionError,
  type ProviderConnectionMetadata,
} from "./provider-connection-store";
import {
  parseProviderModels,
  ProviderProbeError,
} from "../transport/provider-probe";
const Token = z
  .string()
  .trim()
  .max(8192)
  .refine((value) => Buffer.byteLength(value) <= 8192);
const RequestId = z.string().uuid();
const Create = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("environment"),
      requestId: RequestId,
      envSourceId: z.string().min(1).max(100),
      reviewVersion: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      source: z.literal("catalog"),
      requestId: RequestId,
      providerId: z.string().min(1).max(512),
      catalogVersion: z.string().regex(/^[a-f0-9]{64}$/),
      label: z.string().trim().min(1).max(100).optional(),
      token: Token,
    })
    .strict(),
  z
    .object({
      source: z.literal("ollama"),
      requestId: RequestId,
      label: z.string().trim().min(1).max(100).default("Ollama"),
      endpoint: z.url().max(2048).default("http://localhost:11434"),
      token: Token.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("custom"),
      requestId: RequestId,
      label: z.string().trim().min(1).max(100),
      kind: z.enum(["local", "cloud"]),
      endpoint: z.url().max(2048),
      token: Token.optional(),
    })
    .strict(),
]);
export interface ProviderConfigurationService {
  list: (
    actorId: string,
  ) => Promise<{
    connections: ProviderConnectionMetadata[];
    default: { connectionId: string; modelId: string } | null;
    environment: EnvironmentProviderMetadata[];
  }>;
  create: (
    actorId: string,
    raw: unknown,
  ) => Promise<{ id: string; version: string }>;
  update: (actorId: string, raw: unknown) => Promise<void>;
  probe: (
    actorId: string,
    raw: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  saveDefault: (actorId: string, raw: unknown) => Promise<void>;
}
type Connection = {
  id: string;
  version: string;
  label: string;
  protocol: string;
  kind: string;
  endpoint: string;
  token: string | null;
};
async function serviceOperation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof ProviderConnectionError ||
      error instanceof ProviderDestinationError
    )
      throw error;
    logger.error("Provider configuration operation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new ProviderConnectionError(
      503,
      "Provider configuration could not be completed. Try again.",
    );
  }
}
/** Binds validated owner actions to persistence and destination-safe read-only discovery. */
export function createProviderConfigurationService(dependencies: {
  environment?: {
    list: () => EnvironmentProviderMetadata[];
    resolve: (id: string) => EnvironmentProviderMetadata & { token?: string };
  };
  owner: (actorId: string) => Promise<void>;
  catalog: () => Promise<AvailableCatalog>;
  list: (actorId: string) => Promise<ProviderConnectionMetadata[]>;
  getDefault: (
    actorId: string,
  ) => Promise<{ connectionId: string; modelId: string } | null>;
  create: (
    actorId: string,
    input: unknown,
  ) => Promise<{ id: string; version: string }>;
  update: (actorId: string, input: unknown) => Promise<void>;
  saveDefault: (actorId: string, input: unknown) => Promise<void>;
  resolve: (id: string) => Promise<Connection>;
  destination: (endpoint: string, kind: "local" | "cloud") => Promise<unknown>;
  probe: (
    input: {
      endpoint: string;
      kind: "local" | "cloud";
      protocol: "ollama" | "openai-compatible";
      token: string | null;
    },
    signal?: AbortSignal,
  ) => Promise<unknown>;
}): ProviderConfigurationService {
  return {
    list: (actorId) =>
      serviceOperation(async () => {
        await dependencies.owner(actorId);
        return {
          connections: await dependencies.list(actorId),
          default: await dependencies.getDefault(actorId),
          environment: dependencies.environment?.list() ?? [],
        };
      }),
    create: (actorId, raw) =>
      serviceOperation(async () => {
        await dependencies.owner(actorId);
        const parsed = Create.safeParse(raw);
        if (!parsed.success)
          throw new ProviderConnectionError(
            400,
            "Choose a provider, local Ollama service or compatible endpoint with valid connection settings.",
          );
        const input = parsed.data;
        let connection: {
          requestId: string;
          label: string;
          endpoint: string;
          kind: "local" | "cloud";
          protocol: "ollama" | "openai-compatible";
          token?: string;
          catalogProviderId?: string;
          envSourceId?: string;
        };
        if (input.source === "environment") {
          const selected = dependencies.environment?.resolve(input.envSourceId);
          if (!selected || selected.reviewVersion !== input.reviewVersion)
            throw new ProviderConnectionError(
              409,
              "The environment provider destination changed. Refresh and review it before importing.",
            );
          connection = {
            requestId: input.requestId,
            envSourceId: selected.id,
            label: selected.label,
            endpoint: selected.endpoint,
            kind: selected.kind,
            protocol: selected.protocol,
            token: selected.token,
          };
        } else if (input.source === "catalog") {
          const catalog = await dependencies.catalog();
          if (catalog.snapshot.version !== input.catalogVersion)
            throw new ProviderConnectionError(
              409,
              "The provider catalog changed. Review its destination again before saving this token.",
            );
          const selected = catalog.snapshot.providers.find(
            (provider) => provider.id === input.providerId,
          );
          if (
            !selected ||
            selected.compatibility !== "openai-compatible" ||
            !selected.endpoint
          )
            throw new ProviderConnectionError(
              409,
              "This catalog provider needs another protocol adapter or explicit endpoint configuration.",
            );
          connection = {
            requestId: input.requestId,
            label: input.label ?? selected.name,
            endpoint: selected.endpoint,
            kind: "cloud",
            protocol: "openai-compatible",
            token: input.token,
            catalogProviderId: selected.id,
          };
        } else
          connection = {
            requestId: input.requestId,
            label: input.label,
            endpoint: input.endpoint,
            kind: input.source === "ollama" ? "local" : input.kind,
            protocol:
              input.source === "ollama" ? "ollama" : "openai-compatible",
            token: input.token,
          };
        await dependencies.destination(connection.endpoint, connection.kind);
        return await dependencies.create(actorId, connection);
      }),
    update: (actorId, raw) =>
      serviceOperation(async () => {
        await dependencies.owner(actorId);
        await dependencies.update(actorId, raw);
      }),
    saveDefault: (actorId, raw) =>
      serviceOperation(async () => {
        await dependencies.owner(actorId);
        await dependencies.saveDefault(actorId, raw);
      }),
    probe: (actorId, raw, signal) =>
      serviceOperation(async () => {
        await dependencies.owner(actorId);
        const input = z.object({ id: RequestId }).strict().safeParse(raw);
        if (!input.success)
          throw new ProviderConnectionError(
            400,
            "Choose a saved provider connection.",
          );
        const connection = await dependencies.resolve(input.data.id);
        if (
          !["local", "cloud"].includes(connection.kind) ||
          !["ollama", "openai-compatible"].includes(connection.protocol)
        )
          throw new ProviderConnectionError(
            409,
            "The saved connection uses an unsupported protocol or network scope.",
          );
        try {
          const reply = await dependencies.probe(
            {
              endpoint: connection.endpoint,
              kind: connection.kind as "local" | "cloud",
              protocol: connection.protocol as "ollama" | "openai-compatible",
              token: connection.token,
            },
            signal,
          );
          const parsed = parseProviderModels(
            reply,
            connection.protocol as "ollama" | "openai-compatible",
          );
          return { connectionId: connection.id, ...parsed };
        } catch (error) {
          if (error instanceof ProviderProbeError)
            return {
              connectionId: connection.id,
              state: "error",
              models: [],
              error: { category: error.category, message: error.message },
            };
          throw error;
        }
      }),
  };
}
