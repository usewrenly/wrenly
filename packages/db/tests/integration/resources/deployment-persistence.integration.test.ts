// Explicit disposable test database only; never load the operator's .env.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { encryptDeploymentSecret, decryptDeploymentSecret } from '../../../../deploy/src/secrets/deployment-secrets'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_deployment_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Deployment tests require a disposable local wrenly_deployment_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('deployment persistence foundation', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_deployment_test')
  const db = drizzle(client, { schema })
  const owner = `deployment-test-${crypto.randomUUID()}`
  const projectId = crypto.randomUUID()
  const buildId = crypto.randomUUID()
  const encryptionKey = 'ab'.repeat(32)
  const appKey = 'base64:stable-test-key'

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({ id: owner, name: 'Deployment fixture', email: `${owner}@example.test` })
    await db.insert(schema.projects).values({ id: projectId, userId: owner, name: 'Deployment fixture' })
    await db.insert(schema.builds).values({ id: buildId, projectId, prompt: 'Fixture', status: 'success' })
    await db.insert(schema.deploymentResources).values({
      projectId, gitInstanceUrl: 'http://gitea.test', repositoryOwner: 'fixture', repositoryName: `wrenly-${projectId}`,
      coolifyInstanceUrl: 'http://coolify.test', coolifyProjectUuid: 'project', coolifyServerUuid: 'server',
      coolifyEnvironmentName: 'production',
      encryptedLaravelAppKey: encryptDeploymentSecret(appKey, encryptionKey, projectId, 'laravel-app-key'),
    })
  })
  afterAll(async () => {
    try {
      await db.delete(schema.deployments).where(eq(schema.deployments.projectId, projectId))
      await db.delete(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, projectId))
      await db.delete(schema.user).where(eq(schema.user.id, owner))
    } finally { await client.end() }
  })
  function operation(key: string): typeof schema.deployments.$inferInsert {
    return { projectId, buildId, userId: owner, idempotencyKey: key, requestIdentity: buildId,
      stack: 'nextjs', files: [{ path: 'app/page.tsx', content: 'fixture' }], sourceSha256: 'a'.repeat(64) }
  }

  test('migration replay is safe and duplicate request identity cannot create two operations', async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    const key = crypto.randomUUID()
    const attempts = await Promise.allSettled([
      db.insert(schema.deployments).values(operation(key)), db.insert(schema.deployments).values(operation(key)),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
  test('separate operations retain exact snapshots and a stable encrypted app key', async () => {
    await db.insert(schema.deployments).values(operation(crypto.randomUUID()))
    const records = await db.select().from(schema.deployments).where(eq(schema.deployments.projectId, projectId))
    expect(records.length).toBeGreaterThanOrEqual(1)
    expect(records.every(row => row.buildId === buildId && row.status === 'queued')).toBe(true)
    const [resources] = await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, projectId))
    expect(JSON.stringify(resources)).not.toContain(appKey)
    expect(decryptDeploymentSecret(resources?.encryptedLaravelAppKey, encryptionKey, projectId, 'laravel-app-key')).toBe(appKey)
  })
  test('project and build deletion cannot orphan remote identities or deployment operations', async () => {
    await db.insert(schema.deployments).values(operation(crypto.randomUUID()))
    await expect(db.delete(schema.builds).where(eq(schema.builds.id, buildId)).execute()).rejects.toThrow()
    await expect(db.delete(schema.projects).where(eq(schema.projects.id, projectId)).execute()).rejects.toThrow()
    await expect(db.delete(schema.user).where(eq(schema.user.id, owner)).execute()).rejects.toThrow()
  })
})
