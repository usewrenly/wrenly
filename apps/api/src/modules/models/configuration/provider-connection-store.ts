/**
 * Encrypted provider connection persistence.
 * Stores immutable destination/version identities, exact creation replay, safe metadata and instance defaults.
 * Saving does not contact inference services.
 * Tokens decrypt only for server execution/probes and cannot be transplanted across connections.
 */
import { timingSafeEqual } from "node:crypto";
import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  instanceSetup,
  providerConnections,
  providerConnectionAudit,
  instanceModelDefault,
  conversationQueue,
  buildQueue,
  buildJobs,
  conversationTurns,
  projectModels,
} from "../../../../../../packages/db/src/schema";
import {
  loadProviderKey,
  encryptProviderToken,
  decryptProviderToken,
  ProviderKeyError,
} from "../credentials/provider-secrets";
import { ProviderDestinationError } from "../transport/provider-destination";
import { logger } from "../../../lib/logger";
const MAX_CONNECTIONS = 20;
const QUEUE_LOCK_ID = 1;
const MAX_ERROR_CAUSE_DEPTH = 6;
const ACTIVE_BUILD_JOB_STATUSES = ["queued", "running"] as const;
const ACTIVE_TURN_STATUSES = ["queued", "running", "waiting_build"] as const;
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
    endpoint: z.url().max(2048).optional(),
    token: z.string().trim().max(8192).optional(),
    enabled: z.boolean().optional(),
    imageModelIds: z.array(z.string().trim().min(1).max(512)).max(100).refine(ids => new Set(ids).size === ids.length).optional(),
    expectedImageInputRevision: z.string().uuid().optional(),
  })
  .strict();
const Remove = z.object({ id: z.string().uuid() }).strict();
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
    if (
      error instanceof ProviderConnectionError ||
      error instanceof ProviderDestinationError
    )
      throw error;
    if (error instanceof ProviderKeyError)
      throw new ProviderConnectionError(503, error.message);
    let cause: unknown = error;
    for (
      let depth = 0;
      depth < MAX_ERROR_CAUSE_DEPTH && cause && typeof cause === "object";
      depth++
    ) {
      if ("code" in cause && ["55P03", "40P01"].includes(String(cause.code)))
        throw new ProviderConnectionError(
          409,
          "Provider settings are busy. Wait for active work, then try again.",
        );
      cause = "cause" in cause ? cause.cause : null;
    }
    logger.error("Provider connection persistence failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new ProviderConnectionError(
      503,
      "Provider configuration is unavailable. Check PostgreSQL and migrations through 0052.",
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
    .where(
      and(
        isNotNull(providerConnections.credential),
        isNull(providerConnections.deletedAt),
      ),
    )
    .limit(1);
  const key = await loadProviderKey(dataDirectory, Boolean(row));
  // A valid but wrong key file must not create a database containing mixed keys.
  if (row) decryptProviderToken(row.credential, key, row.id);
  return key;
}
function endpointIdentity(input: {
  protocol: string;
  kind: string;
  endpoint: string;
}): string {
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
  imageModelIds: providerConnections.imageModelIds,
  imageInputRevision: providerConnections.imageInputRevision,
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
  imageModelIds?: string[];
  imageInputRevision?: string;
  envSourceId?: string | null;
  boundProjectCount?: number;
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
        .where(isNull(providerConnections.deletedAt))
        .limit(MAX_CONNECTIONS);
      const boundRows = await tx
        .select({
          connectionId: projectModels.connectionId,
          value: count(),
        })
        .from(projectModels)
        .groupBy(projectModels.connectionId);
      const boundCounts = new Map(
        boundRows.map((entry) => [entry.connectionId, entry.value]),
      );
      return rows.map(({ credentialPresent, ...metadata }) => ({
        ...metadata,
        tokenConfigured: credentialPresent === true,
        boundProjectCount: boundCounts.get(metadata.id) ?? 0,
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
          .where(
            and(
              eq(providerConnections.envSourceId, input.envSourceId),
              isNull(providerConnections.deletedAt),
            ),
          );
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
          if (prior.deletedAt !== null)
            throw new ProviderConnectionError(
              409,
              "This request identity belongs to a removed provider connection.",
            );
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
        .from(providerConnections)
        .where(isNull(providerConnections.deletedAt));
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
async function lockQueueTables(tx: Transaction): Promise<void> {
  for (const table of [conversationQueue, buildQueue]) {
    await tx.insert(table).values({ id: QUEUE_LOCK_ID }).onConflictDoNothing();
    await tx
      .select()
      .from(table)
      .where(eq(table.id, QUEUE_LOCK_ID))
      .for("update", { noWait: true });
  }
}

async function assertNoActiveConnectionWork(
  tx: Transaction,
  connectionId: string,
  message: string,
): Promise<void> {
  const activeJobs = await tx
    .select({ input: buildJobs.input })
    .from(buildJobs)
    .where(inArray(buildJobs.status, [...ACTIVE_BUILD_JOB_STATUSES]));
  const activeTurns = await tx
    .select({ provider: conversationTurns.provider })
    .from(conversationTurns)
    .where(inArray(conversationTurns.status, [...ACTIVE_TURN_STATUSES]));
  if (
    activeJobs.some((job) =>
      matchesConnectionIdentity(job.input.provider, connectionId),
    ) ||
    activeTurns.some((turn) =>
      matchesConnectionIdentity(turn.provider, connectionId),
    )
  )
    throw new ProviderConnectionError(409, message);
}

/** Rotates tokens or updates safe settings; changing endpoints rotates the connection version and preserves tokens only on the same origin. */
export function updateProviderConnection(
  database: typeof db,
  actorId: string,
  raw: unknown,
  dataDirectory: string,
  validateDestination?: (
    endpoint: string,
    kind: "local" | "cloud",
  ) => Promise<unknown>,
): Promise<void> {
  return operation(async () => {
    const parsed = Update.safeParse(raw);
    if (!parsed.success)
      throw new ProviderConnectionError(
        400,
        "Only label, endpoint, token, enabled state and reviewed image models can be changed; use a new connection for another protocol or network scope.",
      );
    const input = parsed.data;
    if (input.endpoint !== undefined) {
      await assertProviderConfigurationOwner(database, actorId);
      const [current] = await database
        .select({
          protocol: providerConnections.protocol,
          kind: providerConnections.kind,
          endpoint: providerConnections.endpoint,
        })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.id),
            isNull(providerConnections.deletedAt),
          ),
        );
      if (!current)
        throw new ProviderConnectionError(
          409,
          "Provider connection not found.",
        );
      const normalized = endpointIdentity({
        protocol: current.protocol,
        kind: current.kind,
        endpoint: input.endpoint,
      });
      if (normalized !== current.endpoint && validateDestination)
        await validateDestination(
          normalized,
          current.kind as "local" | "cloud",
        );
    }
    await database.transaction(async (tx) => {
      if (input.endpoint !== undefined) await lockQueueTables(tx);
      await requireOwner(tx, actorId);
      const [row] = await tx
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.id),
            isNull(providerConnections.deletedAt),
          ),
        )
        .for("update");
      if (!row)
        throw new ProviderConnectionError(
          409,
          "Provider connection not found.",
        );
      const nextEndpoint =
        input.endpoint !== undefined
          ? endpointIdentity({
              protocol: row.protocol,
              kind: row.kind,
              endpoint: input.endpoint,
            })
          : undefined;
      const endpointChanged =
        nextEndpoint !== undefined && nextEndpoint !== row.endpoint;
      if (endpointChanged) {
        await assertNoActiveConnectionWork(
          tx,
          row.id,
          "Wait for active conversations and builds using this provider connection to finish or cancel them before changing its endpoint.",
        );
        const originChanged =
          new URL(nextEndpoint).origin !== new URL(row.endpoint).origin;
        if (
          originChanged &&
          (row.credential !== null || row.kind === "cloud") &&
          !input.token?.trim()
        )
          throw new ProviderConnectionError(
            400,
            "Enter the API token again when changing a connection to a different host so saved credentials are never redirected.",
          );
      }
      if (
        input.imageModelIds !== undefined &&
        input.expectedImageInputRevision !== row.imageInputRevision
      ) {
        throw new ProviderConnectionError(
          409,
          "Image input settings changed. Refresh the connection before saving.",
        );
      }
      if (
        input.expectedImageInputRevision !== undefined &&
        input.imageModelIds === undefined
      )
        throw new ProviderConnectionError(
          400,
          "Provide the reviewed image model list.",
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
          ...(endpointChanged
            ? { endpoint: nextEndpoint, version: crypto.randomUUID() }
            : {}),
          ...(input.imageModelIds !== undefined
            ? {
                imageModelIds: input.imageModelIds,
                imageInputRevision: crypto.randomUUID(),
              }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(replacement ? { credential: replacement } : {}),
          updatedAt: new Date(),
        })
        .where(eq(providerConnections.id, row.id));
      await tx.insert(providerConnectionAudit).values({
        actorId,
        connectionId: row.id,
        action: endpointChanged
          ? "endpoint_updated"
          : input.imageModelIds !== undefined
            ? "image_inputs_reviewed"
            : replacement
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
            isNull(providerConnections.deletedAt),
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
function matchesConnectionIdentity(
  provider: string,
  connectionId: string,
): boolean {
  return (
    provider === connectionId || provider.startsWith(`saved:${connectionId}:`)
  );
}

/**
 * Safely tombstones an unused provider connection, immediately destroying encrypted
 * credentials and preserving immutable audit history while fencing against active work.
 */
export function deleteProviderConnection(
  database: typeof db,
  actorId: string,
  raw: unknown,
): Promise<{ deleted: true; clearedInstanceDefault: boolean }> {
  return operation(async () => {
    const parsed = Remove.safeParse(raw);
    if (!parsed.success)
      throw new ProviderConnectionError(
        400,
        "Choose a saved provider connection to remove.",
      );
    const input = parsed.data;
    return database.transaction(async (tx) => {
      await lockQueueTables(tx);
      await requireOwner(tx, actorId);
      const [row] = await tx
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.id),
            isNull(providerConnections.deletedAt),
          ),
        )
        .for("update");
      if (!row)
        throw new ProviderConnectionError(409, "Provider connection not found.");
      await assertNoActiveConnectionWork(
        tx,
        row.id,
        "Wait for active conversations and builds using this provider connection to finish or cancel them before removing it.",
      );
      const [bound] = await tx
        .select({ value: count() })
        .from(projectModels)
        .where(eq(projectModels.connectionId, row.id));
      const boundCount = bound?.value ?? 0;
      if (boundCount > 0)
        throw new ProviderConnectionError(
          409,
          `This provider connection is assigned as the project model for ${boundCount} ${boundCount === 1 ? "project" : "projects"}. Switch ${boundCount === 1 ? "that project" : "those projects"} to another model in Project Settings before removing it.`,
        );
      const cleared = await tx
        .delete(instanceModelDefault)
        .where(
          and(
            eq(instanceModelDefault.id, 1),
            eq(instanceModelDefault.connectionId, row.id),
          ),
        )
        .returning({ id: instanceModelDefault.id });
      const now = new Date();
      await tx
        .update(providerConnections)
        .set({
          deletedAt: now,
          enabled: false,
          credential: null,
          envSourceId: null,
          updatedAt: now,
        })
        .where(eq(providerConnections.id, row.id));
      await tx.insert(providerConnectionAudit).values({
        actorId,
        connectionId: row.id,
        action: "deleted",
      });
      return {
        deleted: true as const,
        clearedInstanceDefault: cleared.length > 0,
      };
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
      .where(
        and(
          eq(providerConnections.id, id),
          isNull(providerConnections.deletedAt),
        ),
      );
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
      "Provider configuration requires migrations through 0052. Check PostgreSQL before starting the API.",
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
