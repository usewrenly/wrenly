// Stores encrypted provider credentials and immutable endpoint/protocol identities.
// Admission selects saved connection versions rather than allowing callers to retarget credentials.
import { pgTable, uuid, text, boolean, timestamp, jsonb, integer } from 'drizzle-orm/pg-core'
import { user } from '../identity/auth'
export const providerConnections = pgTable('provider_connections', {
  createRequestId: uuid('create_request_id').unique(),
  id: uuid('id').primaryKey().defaultRandom(), version: uuid('version').notNull().defaultRandom(),
  label: text('label').notNull(), protocol: text('protocol').notNull(), kind: text('kind').notNull(),
  endpoint: text('endpoint').notNull(), catalogProviderId: text('catalog_provider_id'),
  envSourceId: text('env_source_id').unique(), credential: jsonb('credential').$type<unknown>(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
export const instanceModelDefault = pgTable('instance_model_default', {
  id: integer('id').primaryKey(), connectionId: uuid('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'restrict' }),
  modelId: text('model_id').notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
export const providerConnectionAudit = pgTable('provider_connection_audit', {
  id: uuid('id').primaryKey().defaultRandom(), actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  connectionId: uuid('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'restrict' }),
  action: text('action').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
