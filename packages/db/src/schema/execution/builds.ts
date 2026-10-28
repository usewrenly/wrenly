// Builds table — one record per generation request, with up to three internal
// attempts. An explicit retry creates a new record and preserves old diagnostics.

import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { projects, stackEnum } from '../projects/projects'

export const buildStatusEnum = pgEnum('build_status', [
  'pending', // build created, not yet started
  'generating', // agent is generating files
  'building', // sandbox is running bun install + bun build
  'success', // validation passed; deployment is independent
  'failed', // all attempts failed, errorMessage is populated
])

export const builds = pgTable('builds', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Cascade deletion: if a project is deleted, its builds are deleted.
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),

  // The exact prompt the user submitted. Stored for retry and history display.
  prompt: text('prompt').notNull(),

  // Nullable for historical builds whose inference settings were not recorded.
  model: text('model'),
  provider: text('provider'),
  stack: stackEnum('stack'),
  // The source snapshot used for this request; ownership is validated before use.
  parentBuildId: uuid('parent_build_id'),

  status: buildStatusEnum('status').notNull().default('pending'),

  // How many agent attempts were made (1, 2, or 3).
  // Used in the UI to show "succeeded on attempt N".
  attemptCount: integer('attempt_count').notNull().default(0),

  // The generated FileTree as JSON. Stored for:
  // (1) displaying files in the UI after the build,
  // (2) re-deploying without regenerating.
  // Type: Array<{ path: string; content: string }>
  files: jsonb('files'),

  // The full stdout+stderr output from the sandbox build.
  buildLog: text('build_log'),

  // The last error message on failure. Shown in the UI.
  errorMessage: text('error_message'),

  // The Coolify-assigned URL. Populated on successful deploy.
  deployedUrl: text('deployed_url'),

  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Set when status transitions to 'success' or 'failed'.
  completedAt: timestamp('completed_at'),
})
