// Better Auth organization/membership/invitation tables; membership alone grants no project access.
import { pgTable, text, timestamp, uniqueIndex, uuid, integer } from 'drizzle-orm/pg-core'
import { user } from './auth'
export const organization = pgTable('organization', {
  id: text('id').primaryKey(), name: text('name').notNull(), slug: text('slug').notNull().unique(),
  logo: text('logo'), metadata: text('metadata'), createdAt: timestamp('created_at').notNull(),
})
export const member = pgTable('member', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), createdAt: timestamp('created_at').notNull(),
}, table => [uniqueIndex('member_organization_user_unique').on(table.organizationId, table.userId)])
export const invitation = pgTable('invitation', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(), role: text('role'), status: text('status').notNull().default('pending'),
  inviterId: text('inviter_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  expiresAt: timestamp('expires_at').notNull(), createdAt: timestamp('created_at').notNull().defaultNow(),
})
export const invitationAuthorization = pgTable('invitation_authorization', {
  id: uuid('id').primaryKey(), invitationId: text('invitation_id').notNull().unique().references(() => invitation.id, { onDelete: 'restrict' }),
  issueRequestId: uuid('issue_request_id').notNull().unique(), proofHash: text('proof_hash').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0), revokedAt: timestamp('revoked_at', { withTimezone: true }),
  acceptRequestId: uuid('accept_request_id'), acceptedUserId: text('accepted_user_id').references(() => user.id, { onDelete: 'restrict' }),
  accountCreated: integer('account_created').notNull().default(0), acceptedAt: timestamp('accepted_at', { withTimezone: true }),
})
export const invitationAudit = pgTable('invitation_audit', {
  id: uuid('id').primaryKey().defaultRandom(), authorizationId: uuid('authorization_id').notNull().references(() => invitationAuthorization.id, { onDelete: 'restrict' }),
  actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  email: text('email').notNull(), organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'restrict' }),
  role: text('role').notNull(), action: text('action').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
