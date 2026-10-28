// Stores one-time protected instance setup independently of user count.
// Deleting cookies or accounts must never reopen unrestricted signup.
import { pgTable, integer, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core'
import { user } from './auth'
import { organization } from './organizations'
export const instanceSetup = pgTable('instance_setup', {
  organizationId: text('organization_id').references(() => organization.id, { onDelete: 'restrict' }),
  id: integer('id').primaryKey(),
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'restrict' }),
  proofHash: text('proof_hash'),
  proofExpiresAt: timestamp('proof_expires_at', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  completedRequestId: text('completed_request_id'),
  completedEmail: text('completed_email'),
  initializedAt: timestamp('initialized_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Recovery authorization is purpose-separated from fresh account provisioning.
export const instanceOwnerRecovery = pgTable('instance_owner_recovery', {
  id: integer('id').primaryKey(),
  targetUserId: text('target_user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  proofHash: text('proof_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  completedRequestId: text('completed_request_id'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})
export const instanceOwnerRecoveryAudit = pgTable('instance_owner_recovery_audit', {
  requestId: text('request_id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Review and audit share a durable request record so response retries cannot
// repeat or substitute a project transfer.
export const legacyProjectRecovery = pgTable('legacy_project_recovery', {
  id: uuid('id').primaryKey(),
  actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  sourceId: text('source_id').notNull(),
  projectIds: jsonb('project_ids').$type<string[]>().notNull(),
  fingerprint: text('fingerprint').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  requestId: uuid('request_id').unique(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
