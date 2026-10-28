// Better Auth table definitions.
// These exact field names are required by Better Auth's Drizzle adapter.
// Do not rename fields or change types without updating Better Auth config.
// Authentication writes use Better Auth SDK flows; authoritative access checks also
// read live session/account revisions through Drizzle rather than trusting cookie caches.

import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
} from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  role: text('role').default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  accessRevision: uuid('access_revision').notNull().defaultRandom(),

  name: text('name').notNull(),
  email: text('email').notNull().unique(),

  // Set to true after the user clicks the email verification link.
  // Protected setup and invitation possession do not assert mailbox verification.
  emailVerified: boolean('email_verified').notNull().default(false),

  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const session = pgTable('session', {
  activeOrganizationId: text('active_organization_id'),
  impersonatedBy: text('impersonated_by'),
  accessRevision: uuid('access_revision'),
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),

  // The session token stored in the browser cookie.
  // Better Auth signs this — never forge or expose it.
  token: text('token').notNull().unique(),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),

  // Stores the hashed password for email/password accounts.
  // Never store or log plain-text passwords.
  password: text('password'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})