/**
 * Instance-local catalog cache.
 * Browsing falls back to the bundled licensed snapshot; only explicit owner refresh fetches public data.
 * Failures retain last-good metadata and refresh never changes connections or inference defaults.
 */
import { eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  providerCatalogCache,
  providerCatalogRefreshAudit,
  instanceSetup,
} from "../../../../../../packages/db/src/schema";
import snapshot from "./provider-catalog-snapshot.json";
import {
  fetchProviderCatalog,
  validateCatalogSnapshot,
  type CatalogSnapshot,
  type CatalogFetcher,
  CatalogError,
} from "./provider-catalog";
import { logger } from "../../../lib/logger";
const CACHE_ID = 1;
const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
const bundled = validateCatalogSnapshot(snapshot);
export interface AvailableCatalog {
  snapshot: CatalogSnapshot;
  origin: "bundled" | "cached";
  stale: boolean;
  cacheUnavailable: boolean;
}
export class CatalogAccessError extends Error {
  constructor(
    public readonly status: 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = "CatalogAccessError";
  }
}
/** Returns validated local metadata without any registry network request. */
export async function getAvailableCatalog(
  database: typeof db,
): Promise<AvailableCatalog> {
  try {
    const [saved] = await database
      .select()
      .from(providerCatalogCache)
      .where(eq(providerCatalogCache.id, CACHE_ID));
    const selected = saved ? validateCatalogSnapshot(saved.snapshot) : bundled;
    return {
      snapshot: selected,
      origin: saved ? "cached" : "bundled",
      stale:
        Date.now() - new Date(selected.fetchedAt).getTime() > STALE_AFTER_MS,
      cacheUnavailable: false,
    };
  } catch (error) {
    logger.error("Provider catalog cache unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      snapshot: bundled,
      origin: "bundled",
      stale:
        Date.now() - new Date(bundled.fetchedAt).getTime() > STALE_AFTER_MS,
      cacheUnavailable: true,
    };
  }
}
/** Owner-triggered credential-free refresh; replace cache and append audit in one transaction. */
export async function refreshProviderCatalog(
  database: typeof db,
  actorId: string,
  fetcher: CatalogFetcher = fetch,
): Promise<{ version: string; providers: number; models: number }> {
  try {
    const [setup] = await database
      .select({ ownerId: instanceSetup.ownerId })
      .from(instanceSetup)
      .where(eq(instanceSetup.id, 1));
    if (!setup?.ownerId || setup.ownerId !== actorId)
      throw new CatalogAccessError(
        403,
        "Only the instance owner can refresh the public model catalog.",
      );
    const updated = await fetchProviderCatalog(fetcher);
    const committed = await database.transaction(async (tx) => {
      const [current] = await tx
        .select({ ownerId: instanceSetup.ownerId })
        .from(instanceSetup)
        .where(eq(instanceSetup.id, 1))
        .for("update");
      if (current?.ownerId !== actorId)
        throw new CatalogAccessError(
          403,
          "Instance-owner authorization changed. No catalog was saved.",
        );
      const [existing] = await tx
        .select()
        .from(providerCatalogCache)
        .where(eq(providerCatalogCache.id, CACHE_ID));
      // A slower concurrent fetch must not overwrite a newer validated snapshot.
      // Corrupt cache is repairable from a fresh validated response.
      let selected = updated;
      if (existing) {
        try {
          const cached = validateCatalogSnapshot(existing.snapshot);
          if (
            new Date(cached.fetchedAt).getTime() >
            new Date(updated.fetchedAt).getTime()
          )
            selected = cached;
        } catch {
          /* Replace corrupt cache; never use it as authority. */
        }
      }
      if (selected === updated)
        await tx
          .insert(providerCatalogCache)
          .values({ id: CACHE_ID, snapshot: updated, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: providerCatalogCache.id,
            set: { snapshot: updated, updatedAt: new Date() },
          });
      await tx
        .insert(providerCatalogRefreshAudit)
        .values({ actorId, version: selected.version });
      return selected;
    });
    return {
      version: committed.version,
      providers: committed.providers.length,
      models: committed.providers.reduce(
        (total, provider) => total + provider.models.length,
        0,
      ),
    };
  } catch (error) {
    if (error instanceof CatalogAccessError) throw error;
    logger.error("Provider catalog refresh failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new CatalogAccessError(
      503,
      error instanceof CatalogError
        ? error.message
        : "Catalog refresh could not be saved. The last good catalog is unchanged.",
    );
  }
}
/** Preflight persisted cache/audit schema without contacting the registry. */
export async function verifyProviderCatalogSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select().from(providerCatalogCache).limit(0);
    await database.select().from(providerCatalogRefreshAudit).limit(0);
  } catch {
    throw new Error(
      "Provider catalog storage is unavailable. Apply migrations through 0015 and check PostgreSQL.",
    );
  }
}
