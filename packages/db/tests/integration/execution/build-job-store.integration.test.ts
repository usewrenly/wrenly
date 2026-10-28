// Opt-in disposable PostgreSQL tests; root development DB is never selected.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { asc, eq } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { admitBuild } from '../../../../../apps/api/src/modules/builds/admission/build-admission'
import { createBuildWorkerDependencies } from '../../../../../apps/api/src/modules/builds/execution/build-worker-services'
import { runBuildWorkerCycle } from '../../../../../apps/api/src/modules/builds/execution/build-worker'
import { startProductionBuildWorker } from '../../../../../apps/api/src/modules/builds/execution/production-build-worker'
import { getOwnedBuild, getOwnedBuildEvents } from '../../../../../apps/api/src/modules/builds/persistence/build-queries'
import { createApp } from '../../../../../apps/api/src/app'
import { createBuildHttpHandlers } from '../../../../../apps/api/src/modules/builds/http/http'
import { followDurableBuild, submitDurableBuild } from '../../../../../apps/web/lib/builds/durable-build-client'
import { runBuildWorker } from '../../../../../apps/api/src/modules/builds/execution/build-worker'
import {
  claimNextBuild, recordBuildProgress, renewBuildLease, finishBuild,
  requestBuildCancellation, isBuildCancellationRequested, reconcileExpiredBuild,
  type BuildClaim,
} from '../../../../../apps/api/src/modules/builds/persistence/build-job-store'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_admission_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Job store tests require a disposable local wrenly_admission_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('PostgreSQL execution ownership', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_admission_test')
  const db = drizzle(client, { schema })
  const owner = `job-store-test-${crypto.randomUUID()}`
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({ id: owner, name: 'Job store test', email: `${owner}@example.test` })
  })
  beforeEach(async () => { await db.delete(schema.projects).where(eq(schema.projects.userId, owner)) })
  afterAll(async () => {
    try { await db.delete(schema.user).where(eq(schema.user.id, owner)) }
    finally { await client.end() }
  })
  async function enqueue(): Promise<string> {
    const result = await admitBuild({ projectId: crypto.randomUUID(), prompt: 'Build' }, owner, crypto.randomUUID(), {
      db, defaultModel: 'test-model', resolveProvider: () => ({ id: 'test-provider' }),
    })
    return result.buildId
  }
  async function claim(): Promise<BuildClaim> {
    await enqueue()
    const result = await claimNextBuild(db)
    if (!result) throw new Error('Expected a claim')
    return result
  }
  const files = [{ path: 'package.json', content: '{}' }]

  test('HTTP admission and refreshed browser observation execute one persisted build', async () => {
    const handlers = createBuildHttpHandlers({
      userId: async () => owner,
      admit: (body, userId, key) => admitBuild(body, userId, key, { db, defaultModel: 'test-model', resolveProvider: () => ({ id: 'test-provider' }) }),
      snapshot: (id, userId) => getOwnedBuild(db, id, userId),
      events: (id, userId, after) => getOwnedBuildEvents(db, id, userId, after),
      cancel: (id, userId) => requestBuildCancellation(db, id, userId),
    })
    const unused = async (): Promise<Response> => Response.json({})
    const app = createApp({ builds: handlers, generate: unused, listProjects: unused,
      createProject: unused, getProject: unused, deployProject: unused, getModels: unused,
      auth: unused }, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
    const fetchApi = (path: `/api/${string}`, options?: RequestInit): Promise<Response> => app.request(path, options)
    let generations = 0
    let releaseValidation: () => void = () => {}
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve })
    const services = createBuildWorkerDependencies(db, {
      generate: async () => { generations++; return { files } },
      validate: async () => { await validationGate; return { success: true, output: 'Controlled validation success' } },
      cleanup: async () => {},
    })
    const shutdown = new AbortController()
    const worker = runBuildWorker(services, shutdown.signal, { monitorIntervalMs: 50, pollIntervalMs: 5 })
    try {
      const buildId = await submitDurableBuild({ projectId: crypto.randomUUID(), prompt: 'Build once' }, crypto.randomUUID(), fetchApi, new AbortController().signal)
      const firstReader = new AbortController()
      await followDurableBuild(buildId, { fetch: fetchApi, signal: firstReader.signal,
        snapshot: value => { expect(['queued', 'running']).toContain(value.outcome); firstReader.abort() }, event: () => {}, connection: () => {} })
      releaseValidation()
      await followDurableBuild(buildId, { fetch: fetchApi, signal: new AbortController().signal,
        snapshot: () => {}, event: () => {}, connection: () => {} })
      expect(generations).toBe(1)
      const final = await getOwnedBuild(db, buildId, owner)
      expect(final?.outcome).toBe('success')
      expect(final?.build.files).toEqual(files)
    } finally { releaseValidation(); shutdown.abort(); await worker }
  }, 10_000)
  test('queue explanations expose order and recovery without foreign build identifiers', async () => {
    const running = await claim()
    const first = await enqueue()
    const second = await enqueue()
    const snapshot = await getOwnedBuild(db, first, owner)
    expect(snapshot?.queue).toEqual({ position: 1, reason: 'busy' })
    expect((await getOwnedBuild(db, second, owner))?.queue).toEqual({ position: 2, reason: 'busy' })
    expect(JSON.stringify(snapshot?.queue)).not.toContain(running.buildId)
    await db.update(schema.buildJobs).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.buildJobs.buildId, running.buildId))
    expect((await getOwnedBuild(db, first, owner))?.queue?.reason).toBe('recovering')
  })
  test('public snapshots and event queries enforce ownership and exclude execution secrets', async () => {
    const buildId = await enqueue()
    const snapshot = await getOwnedBuild(db, buildId, owner)
    expect(snapshot?.outcome).toBe('queued')
    expect(snapshot?.cursor).toBe(1)
    expect(snapshot).not.toHaveProperty('input')
    expect(snapshot).not.toHaveProperty('claimToken')
    expect(await getOwnedBuild(db, buildId, 'foreign-owner')).toBeNull()
    expect(await getOwnedBuildEvents(db, buildId, 'foreign-owner', 0)).toEqual([])
    expect((await getOwnedBuildEvents(db, buildId, owner, 0)).map((event) => event.sequence)).toEqual([1])
  })
  test('hydration cursor preserves later source/log events without duplicates', async () => {
    const owned = await claim()
    await recordBuildProgress(db, owned, { type: 'file_tree', attempt: 1, files })
    const snapshot = await getOwnedBuild(db, owned.buildId, owner)
    expect(snapshot?.build.files).toEqual(files)
    expect(snapshot?.cursor).toBe(3)
    await recordBuildProgress(db, owned, { type: 'log_line', attempt: 1, line: 'Arrived after hydration' })
    const replay = await getOwnedBuildEvents(db, owned.buildId, owner, snapshot!.cursor)
    expect(replay.map((event) => event.sequence)).toEqual([4])
    expect(replay[0]?.data.line).toBe('Arrived after hydration')
  })
  test('production lifecycle preflights migrated storage and stops idempotently while idle', async () => {
    const worker = await startProductionBuildWorker(db)
    await Promise.all([worker.stop(), worker.stop()])
    await worker.done
    expect(await claimNextBuild(db)).toBeNull()
  })
  test('wired scheduler executes persisted work once and saves repaired source and terminal events', async () => {
    const buildId = await enqueue()
    let generations = 0
    let validations = 0
    let cleanups = 0
    const services = createBuildWorkerDependencies(db, {
      generate: async (_stack, input) => {
        generations++
        expect(input.model).toBe('test-model')
        if (generations === 2) expect(input.previousErrors.at(-1)).toContain('Compiler detail')
        return { files: [{ path: 'package.json', content: JSON.stringify({ attempt: generations }) }] }
      },
      validate: async () => ++validations === 1
        ? { success: false, output: 'Compiler detail', error: 'Validation failed' }
        : { success: true, output: 'Compiled successfully' },
      cleanup: async () => { cleanups++ },
    })
    expect(await runBuildWorkerCycle(services, new AbortController().signal)).toBe(true)
    expect(generations).toBe(2)
    expect(cleanups).toBe(1)
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, buildId))
    const [job] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId))
    expect(build?.status).toBe('success')
    expect(build?.attemptCount).toBe(2)
    expect(build?.buildLog).toContain('Compiler detail')
    expect(job?.status).toBe('success')
    expect(await runBuildWorkerCycle(services, new AbortController().signal)).toBe(false)
    expect(generations).toBe(2)
  })
  test('competing workers claim only one build globally, including expired executions', async () => {
    await enqueue()
    await enqueue()
    const results = await Promise.all([claimNextBuild(db), claimNextBuild(db)])
    const claims = results.filter((result): result is BuildClaim => result !== null)
    expect(claims).toHaveLength(1)
    await db.update(schema.buildJobs).set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.buildJobs.buildId, claims[0]!.buildId))
    expect(await claimNextBuild(db)).toBeNull()
  })
  test('snapshot and events advance atomically with monotonic sequence and one terminal outcome', async () => {
    const owned = await claim()
    await recordBuildProgress(db, owned, { type: 'file_tree', attempt: 1, files })
    await recordBuildProgress(db, owned, { type: 'log_line', attempt: 1, line: 'Compiled successfully' })
    await finishBuild(db, owned, { status: 'success' })
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, owned.buildId))
    expect(build?.status).toBe('success')
    expect(build?.files).toEqual(files)
    expect(build?.buildLog).toBe('Compiled successfully\n')
    const events = await db.select().from(schema.buildEvents).where(eq(schema.buildEvents.buildId, owned.buildId))
      .orderBy(asc(schema.buildEvents.sequence))
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(events.at(-1)?.data.outcome).toBe('success')
    await expect(finishBuild(db, owned, { status: 'failed', error: 'Late failure' })).rejects.toThrow('valid lease')
    await expect(recordBuildProgress(db, owned, { type: 'log_line', attempt: 1, line: 'Late output' })).rejects.toThrow('valid lease')
  })
  test('expired or wrong tokens cannot renew or change progress', async () => {
    const owned = await claim()
    expect(await renewBuildLease(db, { ...owned, token: crypto.randomUUID() })).toBe(false)
    await expect(recordBuildProgress(db, { ...owned, token: crypto.randomUUID() }, { type: 'file_tree', attempt: 1, files })).rejects.toThrow('valid lease')
    expect(await renewBuildLease(db, owned)).toBe(true)
    await db.update(schema.buildJobs).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.buildJobs.buildId, owned.buildId))
    expect(await renewBuildLease(db, owned)).toBe(false)
    await expect(recordBuildProgress(db, owned, { type: 'file_tree', attempt: 1, files })).rejects.toThrow('valid lease')
  })
  test('cleanup failure retains exclusive expired work; recovery preserves diagnostics without requeue', async () => {
    const owned = await claim()
    await recordBuildProgress(db, owned, { type: 'file_tree', attempt: 1, files })
    await recordBuildProgress(db, owned, { type: 'log_line', attempt: 1, line: 'Partial compiler output' })
    await db.update(schema.buildJobs).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.buildJobs.buildId, owned.buildId))
    await expect(reconcileExpiredBuild(db, async () => { throw new Error('Docker unavailable') })).rejects.toThrow('Docker unavailable')
    expect(await claimNextBuild(db)).toBeNull()
    const cleaned: BuildClaim[] = []
    expect(await reconcileExpiredBuild(db, async (expired) => { cleaned.push(expired) })).toBe(true)
    expect(cleaned[0]?.token).toBe(owned.token)
    const [job] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, owned.buildId))
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, owned.buildId))
    expect(job?.status).toBe('interrupted')
    expect(build?.files).toEqual(files)
    expect(build?.buildLog).toBe('Partial compiler output\n')
    expect(build?.errorMessage).toContain('retry explicitly')
    expect(await claimNextBuild(db)).toBeNull()
    await expect(finishBuild(db, owned, { status: 'success' })).rejects.toThrow('valid lease')
  })
  test('queued cancellation is terminal, owned and idempotent', async () => {
    const buildId = await enqueue()
    expect(await requestBuildCancellation(db, buildId, 'another-owner')).toBe(false)
    expect(await requestBuildCancellation(db, buildId, owner)).toBe(true)
    expect(await requestBuildCancellation(db, buildId, owner)).toBe(true)
    expect(await claimNextBuild(db)).toBeNull()
    const events = await db.select().from(schema.buildEvents).where(eq(schema.buildEvents.buildId, buildId))
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1)
  })
  test('running cancellation retains ownership until cleanup and late cancel cannot replace success', async () => {
    const owned = await claim()
    expect(await isBuildCancellationRequested(db, owned)).toBe(false)
    await requestBuildCancellation(db, owned.buildId, owner)
    expect(await isBuildCancellationRequested(db, owned)).toBe(true)
    expect(await claimNextBuild(db)).toBeNull()
    await recordBuildProgress(db, owned, { type: 'file_tree', attempt: 1, files })
    // Executor may already have completed validation before receiving cancellation.
    await finishBuild(db, owned, { status: 'success' })
    await requestBuildCancellation(db, owned.buildId, owner)
    const [job] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, owned.buildId))
    expect(job?.status).toBe('success')
  })
  test('failed event insertion rolls back source snapshot and sequence changes', async () => {
    const owned = await claim()
    const [job] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, owned.buildId))
    await db.insert(schema.buildEvents).values({ buildId: owned.buildId, sequence: job!.nextEventSequence, type: 'fault-injection', data: {} })
    await expect(recordBuildProgress(db, owned, { type: 'file_tree', attempt: 1, files })).rejects.toThrow()
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, owned.buildId))
    expect(build?.files).toBeNull()
    expect(build?.attemptCount).toBe(0)
    const [unchanged] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, owned.buildId))
    expect(unchanged?.nextEventSequence).toBe(job?.nextEventSequence)
  })
  test('bounds saved and event logs and preserves a truncation notice after reload', async () => {
    const owned = await claim()
    await recordBuildProgress(db, owned, { type: 'log_line', attempt: 1, line: 'x'.repeat(300_000) })
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, owned.buildId))
    expect(build?.buildLog?.length).toBe(256_000)
    expect(build?.buildLog).toStartWith('[Earlier build log truncated]')
    const events = await db.select().from(schema.buildEvents).where(eq(schema.buildEvents.buildId, owned.buildId))
      .orderBy(asc(schema.buildEvents.sequence))
    expect(events.at(-1)?.data.truncated).toBe(true)
    expect((events.at(-1)?.data.line as string).length).toBe(256_000)
  })
  test('rejects ungrounded success, backwards attempts and oversized artifacts', async () => {
    const owned = await claim()
    await expect(finishBuild(db, owned, { status: 'success' })).rejects.toThrow('generated source')
    await recordBuildProgress(db, owned, { type: 'status', attempt: 2, phase: 'generating', message: 'Repairing' })
    await expect(recordBuildProgress(db, owned, { type: 'log_line', attempt: 1, line: 'Out of order' })).rejects.toThrow('backwards')
    await expect(recordBuildProgress(db, owned, { type: 'file_tree', attempt: 2, files: [{ path: 'large', content: 'x'.repeat(3 * 1024 * 1024) }] })).rejects.toThrow('artifact limits')
  })
  test('activity replay is bounded by the snapshot cursor, survives completion and keeps claim/access fences', async () => {
    const owned = await claim()
    await recordBuildProgress(db, owned, {type:'activity_v1',attempt:1,operation:'generation',state:'started'})
    const first = await getOwnedBuild(db, owned.buildId, owner)
    expect(first?.activity?.map(event => event.operation)).toEqual(['generation'])
    expect(first?.activity?.every(event => event.sequence <= first.cursor)).toBe(true)
    await recordBuildProgress(db, owned, {type:'activity_v1',attempt:1,operation:'generation',state:'completed'})
    await recordBuildProgress(db, owned, {type:'activity_v1',attempt:2,operation:'installation',state:'failed'})
    const replay = await getOwnedBuildEvents(db, owned.buildId, owner, first!.cursor)
    expect(replay.map(event => event.type)).toEqual(['activity_v1','activity_v1'])
    await finishBuild(db, owned, {status:'interrupted',error:'Execution interrupted'})
    const final = await getOwnedBuild(db, owned.buildId, owner)
    expect(final?.activity?.map(event => [event.attempt,event.state])).toEqual([[1,'started'],[1,'completed'],[2,'failed']])
    expect(Object.keys(final!.activity![0]!).sort()).toEqual(['sequence','attempt','operation','state','occurredAt'].sort())
    expect(await getOwnedBuild(db, owned.buildId, 'foreign-owner')).toBeNull()
    await expect(recordBuildProgress(db, owned, {type:'activity_v1',attempt:2,operation:'validation',state:'completed'})).rejects.toThrow()
  })

})
