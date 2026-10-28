// Caches validated public model metadata, never credentials or executable provider packages.
import { pgTable, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from '../identity/auth'
export const providerCatalogCache = pgTable('provider_catalog_cache', {
  id: integer('id').primaryKey(), snapshot: jsonb('snapshot').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
export const providerCatalogRefreshAudit = pgTable('provider_catalog_refresh_audit', {
  id: uuid('id').primaryKey().defaultRandom(), actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  version: text('version').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
