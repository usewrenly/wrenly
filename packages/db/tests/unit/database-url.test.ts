import { expect, test } from 'bun:test'
import { readControlDatabaseUrl } from '../../src/connections/database-url'

test('control database configuration accepts PostgreSQL URLs and rejects invalid values without leaking them', () => {
  for (const value of ['postgresql://fixture:secret@localhost:5432/fixture', 'postgres://localhost/fixture'])
    expect(readControlDatabaseUrl({ WRENLY_DATABASE_URL: value })).toBe(value)
  for (const value of [undefined, '', 'not-a-url-private-secret', 'https://private-secret.example.test/db']) {
    try {
      readControlDatabaseUrl({ WRENLY_DATABASE_URL: value })
      throw new Error('Expected invalid URL rejection')
    } catch (error) {
      expect(String(error)).toContain('WRENLY_DATABASE_URL must be a PostgreSQL URL')
      expect(String(error)).not.toContain('private-secret')
    }
  }
})

test('pure schema imports need no database URL while the configured entrypoint fails safely', async () => {
  for (const [entry, expected] of [['@wrenly/db/schema', 0], ['@wrenly/db', 1]] as const) {
    const script = `delete process.env.WRENLY_DATABASE_URL;try{await import(${JSON.stringify(entry)});process.exit(0)}catch(error){process.stderr.write(String(error));process.exit(1)}`
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], {
      cwd: new URL('../..', import.meta.url).pathname, env: {}, stdout: 'ignore', stderr: 'pipe',
    })
    const [status, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(status).toBe(expected)
    if (expected !== 0) expect(diagnostic).toContain('WRENLY_DATABASE_URL must be a PostgreSQL URL')
  }
})
