// Tracks preview lifecycle, claim-owned resources and hashed viewer access separately from builds.
import { pgEnum, pgTable, uuid, text, integer, timestamp, jsonb, primaryKey } from 'drizzle-orm/pg-core'
import { builds } from '../execution/builds'
import { projects } from '../projects/projects'
import { user } from '../identity/auth'

export const previewStatusEnum = pgEnum('preview_status', [
  'queued', 'preparing', 'starting', 'ready', 'failed', 'expired', 'stopped', 'interrupted',
])
export interface PreviewResources {
  appContainerId: string
  ingressContainerId: string
  appNetworkId: string
  ingressNetworkId: string
  preparation?: { imageId: string; lockfileSha256: string | null }
}
export const previewQueue = pgTable('preview_queue', { id: integer('id').primaryKey() })
export const previews = pgTable('previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  buildId: uuid('build_id').notNull().references(() => builds.id, { onDelete: 'restrict' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  files: jsonb('files').$type<Array<{ path: string; content: string }>>().notNull(),
  status: previewStatusEnum('status').notNull().default('queued'),
  claimToken: uuid('claim_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  resources: jsonb('resources').$type<PreviewResources>(),
  log: text('log').notNull().default(''),
  error: text('error'),
  lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  cleanupCompletedAt: timestamp('cleanup_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Multiple request keys can resolve to one active build without losing replay identity.
export const previewRequests = pgTable('preview_requests', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  key: uuid('key').notNull(),
  previewId: uuid('preview_id').notNull().references(() => previews.id, { onDelete: 'cascade' }),
}, table => [primaryKey({ columns: [table.userId, table.key] })])

export const previewAccess = pgTable('preview_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  previewId: uuid('preview_id').notNull().references(() => previews.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  authSessionId: text('auth_session_id'),
  projectRevision: uuid('project_revision').notNull(),
  grantHash: text('grant_hash').notNull().unique(),
  grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  sessionHash: text('session_hash').unique(),
  sessionExpiresAt: timestamp('session_expires_at', { withTimezone: true }),
})
