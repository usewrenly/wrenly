// Creates the shared control-database pool for API accounts, projects and job state.
// postgres.js opens connections lazily; importing this file validates configuration.
// Resource helpers needing only table definitions must use the pure schema entrypoint.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../schema'
import { readControlDatabaseUrl } from './database-url'

// Bound ordinary API concurrency without sharing recovery's stricter session deadlines.
const MAX_CONTROL_CONNECTIONS = 10
const client = postgres(readControlDatabaseUrl(), { max: MAX_CONTROL_CONNECTIONS })
export const db = drizzle(client, { schema })
