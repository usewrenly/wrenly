/**
 * Encrypted provider connection persistence.
 * Stores immutable destination/version identities, exact creation replay, safe metadata and instance defaults.
 * Saving does not contact inference services.
 * Tokens decrypt only for server execution/probes and cannot be transplanted across connections.
 */
import { timingSafeEqual } from "node:crypto";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  instanceSetup,
  providerConnections,
  providerConnectionAudit,
  instanceModelDefault,
} from "../../../../../../packages/db/src/schema";
import {
  loadProviderKey,
  encryptProviderToken,
  decryptProviderToken,
  ProviderKeyError,
} from "../credentials/provider-secrets";
import { logger } from "../../../lib/logger";
const MAX_CONNECTIONS = 20;
const Create = z
  .object({
    requestId: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(100),
    protocol: z.enum(["ollama", "openai-compatible"]),
    kind: z.enum(["local", "cloud"]),
    endpoint: z.url().max(2048),
    token: z.string().trim().max(8192).optional(),
    catalogProviderId: z.string().min(1).max(512).optional(),
    envSourceId: z.string().min(1).max(100).optional(),
  })
  .strict();
const Update = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(100).optional(),
    token: z.string().trim().max(8192).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class ProviderConnectionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ProviderConnectionError";
  }
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProviderConnectionError) throw error;
    if (error instanceof ProviderKeyError)
      throw new ProviderConnectionError(503, error.message);
    logger.error("Provider connection persistence failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new ProviderConnectionError(
      503,
      "Provider configuration is unavailable. Check PostgreSQL and migrations through 0017.",
    );
  }
}
async function requireOwner(tx: Transaction, actorId: string): Promise<void> {
  const [setup] = await tx
    .select({ ownerId: instanceSetup.ownerId })
    .from(instanceSetup)
    .where(eq(instanceSetup.id, 1))
    .for("update");
  if (!setup?.ownerId || setup.ownerId !== actorId)
    throw new ProviderConnectionError(
      403,
      "Only the instance owner can configure shared model providers.",
    );
}
async function keyForWrite(
  tx: Transaction,
  dataDirectory: string,
): Promise<Buffer> {
  const [row] = await tx
    .select({
      id: providerConnections.id,
      credential: providerConnections.credential,
    })
    .from(providerConnections)
    .where(isNotNull(providerConnections.credential))
    .limit(1);
  const key = await loadProviderKey(dataDirectory, Boolean(row));
  // A valid but wrong key file must not create a database containing mixed keys.
  if (row) decryptProviderToken(row.credential, key, row.id);
  return key;
}
function endpointIdentity(input: z.infer<typeof Create>): string {
  const url = new URL(input.endpoint);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !["http:", "https:"].includes(url.protocol) ||
    (input.kind === "cloud" && url.protocol !== "https:") ||
    (input.protocol === "ollama" && input.kind !== "local")
  )
    throw new ProviderConnectionError(
      400,
      "Use a credential-free provider address; hosted connections require HTTPS.",
    );
  if (
    ["0.0.0.0", "169.254.169.254", "metadata.google.internal"].includes(
      url.hostname.toLowerCase(),
    )
  )
    throw new ProviderConnectionError(
      400,
      "This address cannot be used as a model provider.",
    );
  // Resolved-address validation and DNS pinning still gate every future network call.
  return url.href.replace(/\/+$/, "");
}
const Metadata = {
  id: providerConnections.id,
  version: providerConnections.version,
  label: providerConnections.label,
  protocol: providerConnections.protocol,
  kind: providerConnections.kind,
  endpoint: providerConnections.endpoint,
  enabled: providerConnections.enabled,
  catalogProviderId: providerConnections.catalogProviderId,
  envSourceId: providerConnections.envSourceId,
};
export interface ProviderConnectionMetadata {
  id: string;
  version: string;
  label: string;
  protocol: string;
  kind: string;
  endpoint: string;
  enabled: boolean;
  catalogProviderId: string | null;
  tokenConfigured: boolean;
  envSourceId?: string | null;
}
/** Owner-only safe projection; saved tokens and their encrypted envelopes are never returned to the browser. */
export function listProviderConnections(
  database: typeof db,
  actorId: string,
): Promise<ProviderConnectionMetadata[]> {
  return operation(() =>
    database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      const rows = await tx
        .select({
          ...Metadata,
          credentialPresent: isNotNull(providerConnections.credential),
        })
        .from(providerConnections)
        .limit(MAX_CONNECTIONS);
      return rows.map(({ credentialPresent, ...metadata }) => ({
        ...metadata,
        tokenConfigured: credentialPresent === true,
      }));
    }),
  );
}
/** Stores a new immutable destination and bound encrypted token without making external requests. */
export function createProviderConnection(
  database: typeof db,
  actorId: string,
  raw: unknown,
  dataDirectory: string,
): Promise<{ id: string; version: string }> {
  return operation(async () => {
    const parsed = Create.safeParse(raw);
    if (!parsed.success)
      throw new ProviderConnectionError(
        400,
        "Provide valid provider connection settings.",
      );
    const input = parsed.data,
      endpoint = endpointIdentity(input);
    if (input.kind === "cloud" && !input.token?.trim())
      throw new ProviderConnectionError(
        400,
        "Enter the hosted provider token.",
      );
    return database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      if (input.envSourceId) {
        const [prior] = await tx
          .select()
          .from(providerConnections)
          .where(eq(providerConnections.envSourceId, input.envSourceId));
        if (prior) {
          if (
            prior.endpoint !== endpoint ||
            prior.protocol !== input.protocol ||
            prior.kind !== input.kind
          )
            throw new ProviderConnectionError(
              409,
              "This environment source was already imported at another destination. Manage its saved connection or create a new connection explicitly.",
            );
          return { id: prior.id, version: prior.version };
        }
      }
      if (input.requestId) {
        const [prior] = await tx
          .select()
          .from(providerConnections)
          .where(eq(providerConnections.createRequestId, input.requestId));
        if (prior) {
          const priorToken = prior.credential
            ? decryptProviderToken(
                prior.credential,
                await loadProviderKey(dataDirectory, true),
                prior.id,
              )
            : "";
          const suppliedToken = input.token ?? "";
          const tokenMatches =
            Buffer.byteLength(priorToken) ===
              Buffer.byteLength(suppliedToken) &&
            timingSafeEqual(
              Buffer.from(priorToken),
              Buffer.from(suppliedToken),
            );
          if (
            prior.label !== input.label ||
            prior.protocol !== input.protocol ||
            prior.kind !== input.kind ||
            prior.endpoint !== endpoint ||
            prior.envSourceId !== (input.envSourceId ?? null) ||
            prior.catalogProviderId !== (input.catalogProviderId ?? null) ||
            !tokenMatches
          )
            throw new ProviderConnectionError(
              409,
              "This request identity was already used for different connection settings.",
            );
          return { id: prior.id, version: prior.version };
        }
      }
      const [existing] = await tx
        .select({ value: count() })
        .from(providerConnections);
      if ((existing?.value ?? 0) >= MAX_CONNECTIONS)
        throw new ProviderConnectionError(
          409,
          "Provider connection capacity is full.",
        );
      const id = crypto.randomUUID(),
        version = crypto.randomUUID();
      const credential = input.token
        ? encryptProviderToken(
            input.token,
            await keyForWrite(tx, dataDirectory),
            id,
          )
        : null;
      await tx
        .insert(providerConnections)
        .values({
          id,
          version,
          createRequestId: input.requestId,
          label: input.label,
          protocol: input.protocol,
          kind: input.kind,
          endpoint,
          catalogProviderId: input.catalogProviderId,
          envSourceId: input.envSourceId,
          credential,
        });
      await tx
        .insert(providerConnectionAudit)
        .values({
          actorId,
          connectionId: id,
          action: input.envSourceId ? "environment_imported" : "created",
        });
      return { id, version };
    });
  });
}
/** Rotates tokens or changes safe metadata; endpoint/protocol mutation is deliberately not accepted. */
export function updateProviderConnection(
  database: typeof db,
  actorId: string,
  raw: unknown,
  dataDirectory: string,
): Promise<void> {
  return operation(async () => {
    const parsed = Update.safeParse(raw);
    if (!parsed.success)
      throw new ProviderConnectionError(
        400,
        "Only label, token and enabled state can be changed; use a new connection for another endpoint or protocol.",
      );
    const input = parsed.data;
    await database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      const [row] = await tx
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, input.id))
        .for("update");
      if (!row)
        throw new ProviderConnectionError(
          409,
          "Provider connection not found.",
        );
      const replacement = input.token
        ? encryptProviderToken(
            input.token,
            await keyForWrite(tx, dataDirectory),
            row.id,
          )
        : undefined;
      await tx
        .update(providerConnections)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(replacement ? { credential: replacement } : {}),
          updatedAt: new Date(),
        })
        .where(eq(providerConnections.id, row.id));
      await tx
        .insert(providerConnectionAudit)
        .values({
          actorId,
          connectionId: row.id,
          action: replacement
            ? "token_replaced"
            : input.enabled !== undefined
              ? input.enabled
                ? "enabled"
                : "disabled"
              : "metadata_updated",
        });
    });
  });
}
/** Sets an explicit new-admission default; changing it never rewrites queued request settings. */
export function saveInstanceModelDefault(
  database: typeof db,
  actorId: string,
  raw: unknown,
): Promise<void> {
  return operation(async () => {
    const input = z
      .object({
        connectionId: z.string().uuid(),
        modelId: z.string().trim().min(1).max(512),
      })
      .strict()
      .safeParse(raw);
    if (!input.success)
      throw new ProviderConnectionError(
        400,
        "Choose a provider connection and model.",
      );
    await database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      const [row] = await tx
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.data.connectionId),
            eq(providerConnections.enabled, true),
          ),
        )
        .for("update");
      if (!row)
        throw new ProviderConnectionError(
          409,
          "Choose an enabled provider connection.",
        );
      await tx
        .insert(instanceModelDefault)
        .values({ id: 1, ...input.data })
        .onConflictDoUpdate({
          target: instanceModelDefault.id,
          set: { ...input.data, updatedAt: new Date() },
        });
      await tx
        .insert(providerConnectionAudit)
        .values({ actorId, connectionId: row.id, action: "default_selected" });
    });
  });
}
/** Server-only credential lookup for exact connection identity; no fallback and no endpoint retargeting. */
export function resolveSavedProviderConnection(
  database: typeof db,
  id: string,
  dataDirectory: string,
): Promise<{
  id: string;
  version: string;
  label: string;
  protocol: string;
  kind: string;
  endpoint: string;
  token: string | null;
}> {
  return operation(async () => {
    const [row] = await database
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, id));
    if (!row || !row.enabled)
      throw new ProviderConnectionError(
        409,
        "The selected provider connection is unavailable or disabled. Select an enabled connection.",
      );
    return {
      id: row.id,
      version: row.version,
      label: row.label,
      protocol: row.protocol,
      kind: row.kind,
      endpoint: row.endpoint,
      token: row.credential
        ? decryptProviderToken(
            row.credential,
            await loadProviderKey(dataDirectory, true),
            row.id,
          )
        : null,
    };
  });
}
/** Preflight persistence only; startup never creates an encryption key or probes a provider. */
export async function verifyProviderConnectionSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select().from(providerConnections).limit(0);
    await database.select().from(providerConnectionAudit).limit(0);
    await database.select().from(instanceModelDefault).limit(0);
  } catch {
    throw new Error(
      "Provider configuration requires migrations through 0017. Check PostgreSQL before starting the API.",
    );
  }
}

/** Checks administrative scope before catalog resolution, DNS lookup or token decryption. */
export function assertProviderConfigurationOwner(
  database: typeof db,
  actorId: string,
): Promise<void> {
  return operation(() =>
    database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
    }),
  );
}
/** Reads the configured default for owner settings without resolving credentials. */
export function getInstanceModelDefault(
  database: typeof db,
  actorId: string,
): Promise<{ connectionId: string; modelId: string } | null> {
  return operation(() =>
    database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      const [row] = await tx
        .select({
          connectionId: instanceModelDefault.connectionId,
          modelId: instanceModelDefault.modelId,
        })
        .from(instanceModelDefault)
        .where(eq(instanceModelDefault.id, 1));
      return row ?? null;
    }),
  );
}
