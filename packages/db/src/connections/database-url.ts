// Shared startup validation for runtime, recovery and migration-tool connections.
// Error messages never echo URLs: they may contain passwords or private hostnames.
import { z } from 'zod'
const ControlDatabaseUrl = z.url().refine(value => {
  try {
    const url = new URL(value)
    return ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname)
  } catch { return false }
})

/** Reads a PostgreSQL connection URL without opening a connection or loading env files. */
export function readControlDatabaseUrl(environment: Record<string, string | undefined> = process.env): string {
  const result = ControlDatabaseUrl.safeParse(environment.WRENLY_DATABASE_URL)
  if (!result.success) throw new Error('WRENLY_DATABASE_URL must be a PostgreSQL URL (postgresql://user:password@host:5432/database). Set it in the API environment; migration tooling also reads the repository root .env.')
  return result.data
}
