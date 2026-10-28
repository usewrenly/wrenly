// Administrative recovery uses a separate bounded pool so its deadlines do not alter workers.
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../schema'
import type { db } from './client'
import { readControlDatabaseUrl } from './database-url'
const STATEMENT_TIMEOUT_MS = 5000
const CONNECTION_TIMEOUT_SECONDS = 5
/** Runs recovery with server-enforced statement/idle deadlines and closes its pool. */
export async function withRecoveryDatabase<T>(run: (database: typeof db) => Promise<T>): Promise<T> {
  const url = readControlDatabaseUrl()
  const client = postgres(url, { max: 1, connect_timeout: CONNECTION_TIMEOUT_SECONDS,
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS, idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS } })
  try { return await run(drizzle(client, { schema })) }
  finally { await client.end({ timeout: CONNECTION_TIMEOUT_SECONDS }) }
}
