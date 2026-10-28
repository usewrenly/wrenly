/**
 * Configured control-database API: imports the shared pool and validates its URL.
 * Example: API handlers import { db, projects } to save project metadata.
 * For tables/types without a configured pool, use @wrenly/db/schema instead.
 * Isolated generated-app workers use the pure app-database-* subpaths.
 */
export { db } from './connections/client'
export * from './schema'
export { withRecoveryDatabase } from './connections/recovery-client'
