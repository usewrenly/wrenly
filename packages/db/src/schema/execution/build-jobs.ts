// Durable execution claims and immutable inputs; build records separately hold source/history.
import type { SkillGuidance } from "@wrenly/inference"
import type { BuildDatabaseSelection } from "../../application-databases/build-contract"
// Jobs hold immutable execution inputs; builds remain the artifact/history record.
import {
  pgTable, pgEnum, uuid, text, integer, timestamp, jsonb, uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core'
import { builds } from './builds'
import { projects } from '../projects/projects'
import { user } from '../identity/auth'

export const buildJobStatusEnum = pgEnum('build_job_status', [
  'queued', 'running', 'success', 'failed', 'interrupted', 'cancelled',
])

export interface BuildJobInput {
  databaseV1?: BuildDatabaseSelection
  skillsV1?: SkillGuidance
  prompt: string
  stack: 'nextjs' | 'laravel' | 'vue' | 'django'
  model: string
  provider: string
  previousFiles: Array<{ path: string; content: string }>
  previousErrors: string[]
}

// A single lock row serializes admission capacity checks across API processes.
export const buildQueue = pgTable('build_queue', {
  id: integer('id').primaryKey(),
})

export const buildJobs = pgTable('build_jobs', {
  buildId: uuid('build_id').primaryKey().references(() => builds.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  idempotencyKey: uuid('idempotency_key').notNull(),
  // Store normalized caller input separately from resolved defaults for safe replay.
  requestIdentity: text('request_identity').notNull(),
  input: jsonb('input').$type<BuildJobInput>().notNull(),
  status: buildJobStatusEnum('status').notNull().default('queued'),
  claimToken: uuid('claim_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
  nextEventSequence: integer('next_event_sequence').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('build_jobs_user_idempotency_unique').on(table.userId, table.idempotencyKey),
])

export const buildEvents = pgTable('build_events', {
  buildId: uuid('build_id').notNull().references(() => builds.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.buildId, table.sequence] })])
