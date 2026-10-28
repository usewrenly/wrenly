// Persists attributed conversation turns, messages and atomic build actions.
// Saved decisions/inputs survive reconnects; browser subscriptions never own execution.
import type { BuildDatabaseSelection } from "../../application-databases/build-contract"
import type { SkillGuidance } from "@wrenly/inference"
import { pgTable, pgEnum, uuid, text, integer, timestamp, uniqueIndex, jsonb, primaryKey } from 'drizzle-orm/pg-core'
import { projects } from '../projects/projects'
import { builds } from './builds'
import { user } from '../identity/auth'

export const conversationModeEnum = pgEnum('conversation_mode', ['auto', 'ask', 'build', 'plan'])
export const conversationTurnStatusEnum = pgEnum('conversation_turn_status', [
  'queued', 'running', 'waiting_build', 'completed', 'failed', 'interrupted', 'cancelled',
])
export const conversationRoleEnum = pgEnum('conversation_role', ['user', 'assistant'])

export const conversationQueue = pgTable('conversation_queue', { id: integer('id').primaryKey() })
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  nextMessageSequence: integer('next_message_sequence').notNull().default(1),
  turnCount: integer('turn_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('conversations_project_unique').on(table.projectId)])

export const conversationTurns = pgTable('conversation_turns', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  idempotencyKey: uuid('idempotency_key').notNull(),
  requestIdentity: text('request_identity').notNull(),
  mode: conversationModeEnum('mode').notNull(),
  prompt: text('prompt').notNull(),
  skillsV1: jsonb('skills_v1').$type<SkillGuidance>().notNull().default({ version: 1, skills: [] }),
  databaseV1: jsonb('database_v1').$type<BuildDatabaseSelection>(),
  baseBuildId: uuid('base_build_id').references(() => builds.id, { onDelete: 'restrict' }),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  status: conversationTurnStatusEnum('status').notNull().default('queued'),
  claimToken: uuid('claim_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  nextEventSequence: integer('next_event_sequence').notNull().default(2),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [uniqueIndex('conversation_turns_actor_idempotency_unique').on(table.conversationId, table.actorId, table.idempotencyKey)])

export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  turnId: uuid('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  role: conversationRoleEnum('role').notNull(),
  actorId: text('actor_id').references(() => user.id, { onDelete: 'restrict' }),
  content: text('content').notNull(),
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('conversation_messages_sequence_unique').on(table.conversationId, table.sequence)])

export const conversationActions = pgTable('conversation_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  turnId: uuid('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
  buildId: uuid('build_id').notNull().references(() => builds.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('conversation_actions_turn_unique').on(table.turnId),
  uniqueIndex('conversation_actions_build_unique').on(table.buildId),
])

export const conversationEvents = pgTable('conversation_events', {
  turnId: uuid('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.turnId, table.sequence] })])
