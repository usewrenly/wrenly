import { laravelFixture } from '../../../../sandbox/tests/laravel-fixture'
// Runs only against an explicitly configured disposable database; never root .env.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { admitBuild, type AdmissionDependencies } from '../../../../../apps/api/src/modules/builds/admission/build-admission'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_admission_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Admission tests require a disposable local wrenly_admission_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('PostgreSQL build admission', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_admission_test')
  const db = drizzle(client, { schema })
  const owner = `admission-test-${crypto.randomUUID()}`
  const dependencies: AdmissionDependencies = {
    db, defaultModel: 'test-model', resolveProvider: () => ({ id: 'test-provider' }),
  }
  const foreignOwner = `${owner}-foreign`
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({id:foreignOwner,name:'Foreign test account',email:`${foreignOwner}@example.test`})
    await db.insert(schema.user).values({ id: owner, name: 'Admission test', email: `${owner}@example.test` })
  })
  afterAll(async () => {
    await db.delete(schema.user).where(eq(schema.user.id,foreignOwner))
    try { await db.delete(schema.user).where(eq(schema.user.id, owner)) }
    finally { await client.end() }
  })
  test('admits Laravel revision editing without falling back to full regeneration', async () => {
    const projectId = crypto.randomUUID()
    const buildId = crypto.randomUUID()
    await db.insert(schema.projects).values({ id: projectId, userId: owner, name: 'Laravel', stack: 'laravel' })
    await db.insert(schema.builds).values({ id: buildId, projectId, prompt: 'Original', status: 'success', stack: 'laravel', files: laravelFixture() })
    const result = await admitBuild({ projectId, previousBuildId: buildId, prompt: 'Change the heading' }, owner, crypto.randomUUID(), dependencies)
    const [saved] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, result.buildId))
    expect(saved?.input.previousFiles).toEqual(laravelFixture())
  })
  test('concurrent duplicate submissions create exactly one build/job/event', async () => {
    const projectId = crypto.randomUUID()
    const key = crypto.randomUUID()
    const body = { projectId, prompt: 'Build an app' }
    const results = await Promise.all([
      admitBuild(body, owner, key, dependencies),
      admitBuild(body, owner, key, dependencies),
    ])
    expect(results[0]?.buildId).toBe(results[1]?.buildId)
    expect(results.filter((result) => result.replayed)).toHaveLength(1)
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(1)
    const buildId = results[0]!.buildId
    expect(await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId))).toHaveLength(1)
    const events = await db.select().from(schema.buildEvents).where(eq(schema.buildEvents.buildId, buildId))
    expect(events).toHaveLength(1)
    expect(events[0]?.sequence).toBe(1)
    expect(events[0]?.data.phase).toBe('queued')
  })
  test('conflicting key and simultaneous project requests cannot create extra builds', async () => {
    const projectId = crypto.randomUUID()
    const key = crypto.randomUUID()
    const body = { projectId, prompt: 'First request' }
    await admitBuild(body, owner, key, dependencies)
    await expect(admitBuild({ ...body, prompt: 'Different' }, owner, key, dependencies)).rejects.toThrow('idempotency key')
    await expect(admitBuild(body, owner, crypto.randomUUID(), dependencies)).rejects.toThrow('active build')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(1)
  })
  test('concurrent distinct requests for a new project admit only one', async () => {
    const projectId = crypto.randomUUID()
    const results = await Promise.allSettled([
      admitBuild({ projectId, prompt: 'First' }, owner, crypto.randomUUID(), dependencies),
      admitBuild({ projectId, prompt: 'Second' }, owner, crypto.randomUUID(), dependencies),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(1)
  })
  test('rejected provider resolution rolls back implicit project creation', async () => {
    const projectId = crypto.randomUUID()
    await expect(admitBuild({ projectId, prompt: 'Build' }, owner, crypto.randomUUID(), {
      ...dependencies, resolveProvider: () => { throw new Error('Unavailable') },
    })).rejects.toThrow('provider is unavailable')
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))).toHaveLength(0)
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(0)
  })
  test('bounds queue admission and rolls back a rejected new project', async () => {
    // Clear this suite's prior work before exercising the capacity boundary.
    await db.delete(schema.projects).where(eq(schema.projects.userId, owner))
    for (let index = 0; index < 20; index++) {
      await admitBuild({ projectId: crypto.randomUUID(), prompt: 'Queued' }, owner, crypto.randomUUID(), dependencies)
    }
    const rejectedProjectId = crypto.randomUUID()
    await expect(admitBuild({ projectId: rejectedProjectId, prompt: 'Overflow' }, owner, crypto.randomUUID(), dependencies)).rejects.toThrow('queue is full')
    expect(await db.select().from(schema.projects).where(eq(schema.projects.id, rejectedProjectId))).toHaveLength(0)
    await db.delete(schema.projects).where(eq(schema.projects.userId, owner))
  })
  test('foreign projects and parents remain inaccessible', async () => {
    const projectId = crypto.randomUUID()
    const admitted = await admitBuild({ projectId, prompt: 'Build' }, owner, crypto.randomUUID(), dependencies)
    await expect(admitBuild({ projectId, prompt: 'Intrude' }, `${owner}-foreign`, crypto.randomUUID(), dependencies)).rejects.toThrow('Project not found')
    const anotherProject = crypto.randomUUID()
    await db.insert(schema.projects).values({ id: anotherProject, userId: owner, name: 'Other project' })
    await expect(admitBuild({ projectId: anotherProject, prompt: 'Reuse', previousBuildId: admitted.buildId }, owner, crypto.randomUUID(), dependencies)).rejects.toThrow('Previous build not found')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, anotherProject))).toHaveLength(0)
  })
  test('retry before an edit emits files restores its frozen job source, never an empty or newer base', async () => {
    const projectId = crypto.randomUUID()
    const original = await admitBuild({ projectId, prompt: 'Initial app' }, owner, crypto.randomUUID(), dependencies)
    const files = [{ path: 'package.json', content: '{}' }, { path: 'keep.ts', content: 'Frozen source' }]
    await db.update(schema.builds).set({ status: 'success', files }).where(eq(schema.builds.id, original.buildId))
    await db.update(schema.buildJobs).set({ status: 'success' }).where(eq(schema.buildJobs.buildId, original.buildId))
    const edit = await admitBuild({ projectId, prompt: 'Change heading', previousBuildId: original.buildId }, owner, crypto.randomUUID(), dependencies)
    await db.update(schema.builds).set({ status: 'failed', errorMessage: 'Interrupted before source', files: null }).where(eq(schema.builds.id, edit.buildId))
    await db.update(schema.buildJobs).set({ status: 'interrupted' }).where(eq(schema.buildJobs.buildId, edit.buildId))
    await db.update(schema.builds).set({ files: [{ path: 'package.json', content: 'Different later source' }] }).where(eq(schema.builds.id, original.buildId))
    const retry = await admitBuild({ projectId, retryBuildId: edit.buildId }, owner, crypto.randomUUID(), dependencies)
    const [saved] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, retry.buildId))
    expect(saved?.input.previousFiles).toEqual(files)
    expect(saved?.input.prompt).toBe('Change heading')
  })
  test('legacy edit retry without recoverable source rejects instead of regenerating', async () => {
    const projectId = crypto.randomUUID(); const base = crypto.randomUUID(); const failed = crypto.randomUUID()
    await db.insert(schema.projects).values({ id: projectId, userId: owner, name: 'Legacy edit' })
    await db.insert(schema.builds).values([
      { id: base, projectId, prompt: 'Base', status: 'success', files: [{ path: 'package.json', content: '{}' }] },
      { id: failed, projectId, prompt: 'Change', status: 'failed', parentBuildId: base, model: 'test-model', provider: 'test-provider', stack: 'nextjs' },
    ])
    await expect(admitBuild({ projectId, retryBuildId: failed }, owner, crypto.randomUUID(), dependencies)).rejects.toThrow('recoverable source context')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(2)
    const otherProject = crypto.randomUUID()
    await db.insert(schema.projects).values({ id: otherProject, userId: owner, name: 'Other retry project' })
    await expect(admitBuild({ projectId: otherProject, retryBuildId: failed }, owner, crypto.randomUUID(), dependencies)).rejects.toThrow('Previous build not found')
  })

})
