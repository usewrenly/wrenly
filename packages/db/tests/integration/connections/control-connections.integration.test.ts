// Disposable control-cluster acceptance; never fall back to the operator URL.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { pgSchema, serial, text, bigint } from 'drizzle-orm/pg-core'
import { withRecoveryDatabase } from '../../../src/connections/recovery-client'
import { user } from '../../../src/schema'
import { readFileSync } from 'node:fs'

const url = process.env.WRENLY_TEST_FOUNDATION_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/wrenly_foundation_test')
    throw new Error('Use a disposable local wrenly_foundation_test database.')
}
const integration = url ? test : test.skip
const previousUrl = process.env.WRENLY_DATABASE_URL
beforeAll(() => { if (url) process.env.WRENLY_DATABASE_URL = url })
afterAll(() => {
  if (previousUrl === undefined) delete process.env.WRENLY_DATABASE_URL
  else process.env.WRENLY_DATABASE_URL = previousUrl
})
const migrations = pgSchema('drizzle').table('__drizzle_migrations', {
  id: serial('id').primaryKey(), hash: text('hash').notNull(), createdAt: bigint('created_at', { mode: 'number' }),
})

integration('migration history matches the full journal and recovery reads the configured control database', async () => {
  const journal = JSON.parse(readFileSync(new URL('../../../migrations/meta/_journal.json', import.meta.url), 'utf8')) as { entries: unknown[] }
  const rows = await withRecoveryDatabase(database => database.select().from(migrations))
  expect(rows).toHaveLength(journal.entries.length)
  expect(new Set(rows.map(row => row.hash)).size).toBe(rows.length)
  expect(await withRecoveryDatabase(database => database.select({ id: user.id }).from(user).limit(1))).toEqual([])
})
integration('a failed recovery callback releases its pool and a subsequent recovery can connect', async () => {
  await expect(withRecoveryDatabase(async () => { throw new Error('fixture recovery failure') })).rejects.toThrow('fixture recovery failure')
  expect(await withRecoveryDatabase(database => database.select({ id: user.id }).from(user).limit(1))).toEqual([])
})
