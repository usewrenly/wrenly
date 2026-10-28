// Projects table — one project per app a user creates in Wrenly.
// A project holds configuration (name, stack) and links to its build history.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  pgEnum,
  jsonb,
} from 'drizzle-orm/pg-core'
import { user } from '../identity/auth'

// Persisted framework identifiers include roadmap stacks, not a runtime-support promise.
// A new supported stack also needs MCP, source-policy, sandbox and deployment verification.
export const stackEnum = pgEnum('stack', [
  'nextjs',
  'laravel',
  'vue',
  'django',
])

export const projectAccessModeEnum = pgEnum('project_access_mode', ['private', 'selected', 'instance'])
export const projectMemberRoleEnum = pgEnum('project_member_role', ['viewer', 'editor'])

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Cascade deletion: if a user is deleted, all their projects are deleted.
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),

  // The display name shown in the sidebar. Set on first build if not provided.
  name: text('name').notNull(),

  // Optional: a short description of what the project is.
  description: text('description'),

  // The framework this project generates code for.
  // Determines which MCP agent the orchestrator routes to.
  stack: stackEnum('stack').notNull().default('nextjs'),

  // Private-by-default backfill never grants existing accounts access.
  accessMode: projectAccessModeEnum('access_mode').notNull().default('private'),
  instanceRole: projectMemberRoleEnum('instance_role').notNull().default('viewer'),
  accessRevision: uuid('access_revision').notNull().defaultRandom(),
  previewMediaOrigins: jsonb('preview_media_origins').$type<string[]>().notNull().default([]),

  archivedAt: timestamp('archived_at', { withTimezone: true }),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
