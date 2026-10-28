import { laravelFixture } from '../../../../sandbox/tests/laravel-fixture'
// Opt-in disposable PostgreSQL tests; never select the development database.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { hashFixturePassword } from '../../../../../apps/api/src/test-support/fixture-password'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, inArray } from 'drizzle-orm'
import { resolve } from 'path'
import { issuePreviewGrant, consumePreviewGrant, authorizePreviewSession, previewOrigin } from '../../../../../apps/api/src/modules/previews/access/preview-access'
import { createPreviewHttpHandlers } from '../../../../../apps/api/src/modules/previews/http/http'
import { startProductionPreviewWorker } from '../../../../../apps/api/src/modules/previews/execution/production-preview-worker'
import { parseApiEnvironment } from '../../../../../apps/api/src/config/api-environment'
import { createPreviewGateway, PREVIEW_COOKIE } from '../../../../../apps/api/src/modules/previews/gateway/preview-gateway'
import { touchPreviewViewer } from '../../../../../apps/api/src/modules/previews/persistence/preview-store'
import { createPreviewWorkerDependencies, verifyPreviewWorkerSchema, type PreviewRuntimeAdapters } from '../../../../../apps/api/src/modules/previews/execution/preview-worker-services'
import { runPreviewWorker } from '../../../../../apps/api/src/modules/previews/execution/preview-worker'
import * as schema from '../../../src/schema'
import {
  admitPreview, claimNextPreview, renewPreviewLease, updatePreviewProgress, failPreview,
  stopPreview, touchPreviewViewer, reconcilePreview, getOwnedPreview, type PreviewClaim,
} from '../../../../../apps/api/src/modules/previews/persistence/preview-store'

const testUrl = process.env.WRENLY_TEST_PREVIEW_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_preview_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Preview tests require a disposable local wrenly_preview_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('PostgreSQL preview lifecycle', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_preview_test')
  const db = drizzle(client, { schema })
  const owner = `preview-test-${crypto.randomUUID()}`
  const files = [{ path: 'package.json', content: '{"scripts":{"start":"next start"}}' }]
  const resources = { appContainerId: 'a'.repeat(64), ingressContainerId: 'b'.repeat(64), appNetworkId: 'c'.repeat(64), ingressNetworkId: 'd'.repeat(64) }
  const foreignOwner = `${owner}-foreign`
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({id:foreignOwner,name:'Foreign test account',email:`${foreignOwner}@example.test`})
    await db.insert(schema.user).values({ id: owner, name: 'Preview test', email: `${owner}@example.test` })
  })
  beforeEach(async () => {
    await db.delete(schema.previews).where(inArray(schema.previews.userId, [owner, foreignOwner]))
    await db.delete(schema.projects).where(inArray(schema.projects.userId, [owner, foreignOwner]))
  })
  afterAll(async () => {
    await db.delete(schema.previews).where(inArray(schema.previews.userId, [owner, foreignOwner]))
    await db.delete(schema.projects).where(eq(schema.projects.userId, foreignOwner))
    await db.delete(schema.user).where(eq(schema.user.id,foreignOwner))
    try {
      await db.delete(schema.previews).where(inArray(schema.previews.userId, [owner, foreignOwner]))
      await db.delete(schema.projects).where(inArray(schema.projects.userId, [owner, foreignOwner]))
      await db.delete(schema.user).where(eq(schema.user.id, owner))
    } finally { await client.end() }
  })
  async function controlSession(userId = owner): Promise<string> {
    const id = crypto.randomUUID()
    const [account] = await db.select().from(schema.user).where(eq(schema.user.id, userId))
    await db.insert(schema.session).values({ id, userId, accessRevision: account!.accessRevision,
      token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) })
    return id
  }
  async function build(projectId = crypto.randomUUID(), actorId = owner): Promise<string> {
    await db.insert(schema.projects).values({ id: projectId, userId: actorId, name: 'Fixture', stack: 'nextjs' }).onConflictDoNothing()
    const id = crypto.randomUUID()
    await db.insert(schema.builds).values({ id, projectId, prompt: 'Fixture', stack: 'nextjs', status: 'success', files })
    return id
  }
  async function claim(): Promise<PreviewClaim & { files: typeof files }> {
    await admitPreview(db, await build(), owner, crypto.randomUUID())
    const result = await claimNextPreview(db)
    if (!result) throw new Error('Expected a preview claim.')
    return result
  }
  async function ready(): Promise<PreviewClaim> {
    const result = await claim()
    await updatePreviewProgress(db, result, { type: 'starting', resources })
    await updatePreviewProgress(db, result, { type: 'ready' })
    return result
  }
  test('concurrent admissions freeze source once and preserve every replay key', async () => {
    const id = await build()
    const keys = [crypto.randomUUID(), crypto.randomUUID()]
    const results = await Promise.all(keys.map(key => admitPreview(db, id, owner, key)))
    expect(results[0]!.previewId).toBe(results[1]!.previewId)
    await db.update(schema.builds).set({ files: [{ path: 'changed.txt', content: 'changed' }] }).where(eq(schema.builds.id, id))
    const claimed = await claimNextPreview(db)
    expect(claimed?.files).toEqual(files)
    await stopPreview(db, results[0]!.previewId, owner)
    for (const key of keys) expect((await admitPreview(db, id, owner, key)).previewId).toBe(results[0]!.previewId)
    expect((await db.select().from(schema.previews)).length).toBe(1)
  })
  test('foreign requests and snapshots do not reveal or stop an owned preview', async () => {
    const claimed = await claim()
    await expect(admitPreview(db, claimed.buildId, foreignOwner, crypto.randomUUID())).rejects.toMatchObject({ status: 404 })
    expect(await getOwnedPreview(db, claimed.previewId, foreignOwner)).toBeNull()
    expect(await stopPreview(db, claimed.previewId, foreignOwner)).toBe(false)
    expect(await touchPreviewViewer(db, claimed.previewId, foreignOwner)).toBe(false)
    const snapshot = await getOwnedPreview(db, claimed.previewId, owner)
    expect(snapshot).not.toHaveProperty('claimToken')
    expect(snapshot).not.toHaveProperty('resources')
    expect(snapshot).not.toHaveProperty('files')
  })
  test('rejects reused keys for another build and competing project revisions', async () => {
    const projectId = crypto.randomUUID()
    const first = await build(projectId)
    const second = await build(projectId)
    const key = crypto.randomUUID()
    await admitPreview(db, first, owner, key)
    await expect(admitPreview(db, second, owner, key)).rejects.toMatchObject({ status: 409 })
    await expect(admitPreview(db, second, owner, crypto.randomUUID())).rejects.toMatchObject({ status: 409 })
  })
  test('admits Laravel 13 with frozen source and carries stack into execution', async () => {
    const projectId = crypto.randomUUID()
    const id = await build(projectId)
    await db.update(schema.projects).set({ stack: 'laravel' }).where(eq(schema.projects.id, projectId))
    const source = laravelFixture()
    await db.update(schema.builds).set({ stack: 'laravel', files: source }).where(eq(schema.builds.id, id))
    const admitted = await admitPreview(db, id, owner, crypto.randomUUID())
    const execution = await claimNextPreview(db)
    expect(execution?.previewId).toBe(admitted.previewId)
    expect(execution?.stack).toBe('laravel')
    expect(execution?.files).toEqual(source)
  })
  test('rejects unsuccessful, unsupported and unsafe source builds', async () => {
    for (const patch of [{ status: 'failed' as const }, { stack: 'laravel' as const }, { files: [] }, { files: [{ path: '../escape', content: 'bad' }] }]) {
      const id = await build()
      await db.update(schema.builds).set(patch).where(eq(schema.builds.id, id))
      await expect(admitPreview(db, id, owner, crypto.randomUUID())).rejects.toThrow()
    }
    expect((await db.select().from(schema.previews)).length).toBe(0)
  })
  test('concurrent instance capacity and preparation claims remain bounded', async () => {
    const ids = await Promise.all([build(), build(), build()])
    const admissions = await Promise.allSettled(ids.map(id => admitPreview(db, id, owner, crypto.randomUUID())))
    expect(admissions.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    const claims = await Promise.all([claimNextPreview(db), claimNextPreview(db)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const first = claims.find(Boolean)!
    await updatePreviewProgress(db, first, { type: 'starting', resources })
    await updatePreviewProgress(db, first, { type: 'ready' })
    expect(await claimNextPreview(db)).not.toBeNull()
  })
  test('a second account can prepare and open its own preview while the first account stays ready', async () => {
    const first = await ready();
    const secondBuild = await build(crypto.randomUUID(), foreignOwner);
    const sessionId = await controlSession(foreignOwner);
    const handlers = createPreviewHttpHandlers(db, { enabled: true, baseUrl: 'http://wrenly-preview.localhost:3003',
      user: async () => ({ id: foreignOwner, authSessionId: sessionId }) });
    const request = new Request('http://localhost/api', { headers: { 'idempotency-key': crypto.randomUUID() } });
    expect((await (await handlers.get(request, secondBuild)).json()).enabled).toBe(true);
    expect((await handlers.create(request, secondBuild)).status).toBe(202);
    const second = (await claimNextPreview(db))!;
    expect(second.buildId).toBe(secondBuild);
    await updatePreviewProgress(db, second, { type: 'starting', resources });
    await updatePreviewProgress(db, second, { type: 'ready' });
    expect((await handlers.access(request, second.previewId)).status).toBe(200);
    expect((await getOwnedPreview(db, first.previewId, owner))?.status).toBe('ready');
    expect(await getOwnedPreview(db, first.previewId, foreignOwner)).toBeNull();
    expect(await stopPreview(db, second.previewId, foreignOwner)).toBe(true);
    expect((await getOwnedPreview(db, first.previewId, owner))?.status).toBe('ready');
  })
  test('requires ordered transitions and fences stale/expired claims', async () => {
    const claimed = await claim()
    await expect(updatePreviewProgress(db, claimed, { type: 'ready' })).rejects.toMatchObject({ status: 409 })
    await expect(renewPreviewLease(db, { ...claimed, token: crypto.randomUUID() })).rejects.toThrow('valid lease')
    await updatePreviewProgress(db, claimed, { type: 'starting', resources })
    await expect(updatePreviewProgress(db, claimed, { type: 'starting', resources })).rejects.toThrow()
    await db.update(schema.previews).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.previews.id, claimed.previewId))
    await expect(updatePreviewProgress(db, claimed, { type: 'ready' })).rejects.toThrow('valid lease')
    await expect(renewPreviewLease(db, claimed)).rejects.toThrow('valid lease')
  })
  test('bounds logs/errors and leaves build success untouched', async () => {
    const claimed = await claim()
    await updatePreviewProgress(db, claimed, { type: 'log', text: 'x'.repeat(300_000) })
    await updatePreviewProgress(db, claimed, { type: 'log', text: 'tail' })
    const state = await getOwnedPreview(db, claimed.previewId, owner)
    expect(state!.log.length).toBeLessThanOrEqual(256_000)
    expect(state!.log.endsWith('tail')).toBe(true)
    await failPreview(db, claimed, 'e'.repeat(3000))
    expect((await getOwnedPreview(db, claimed.previewId, owner))!.error!.length).toBe(2000)
    const [savedBuild] = await db.select().from(schema.builds).where(eq(schema.builds.id, claimed.buildId))
    expect(savedBuild!.status).toBe('success')
    expect(savedBuild!.files).toEqual(files)
  })
  test('stop revokes readiness immediately; cleanup failure retains capacity and resources', async () => {
    const claimed = await ready()
    await stopPreview(db, claimed.previewId, owner)
    expect((await getOwnedPreview(db, claimed.previewId, owner))?.status).toBe('stopped')
    expect(await touchPreviewViewer(db, claimed.previewId, owner)).toBe(false)
    await expect(renewPreviewLease(db, claimed)).rejects.toThrow()
    await updatePreviewProgress(db, claimed, { type: 'log', text: 'Final output after stop' })
    await expect(updatePreviewProgress(db, { ...claimed, token: crypto.randomUUID() }, { type: 'log', text: 'foreign output' })).rejects.toThrow()
    await expect(reconcilePreview(db, async () => { throw new Error('Controlled cleanup failure') })).rejects.toThrow()
    const [row] = await db.select().from(schema.previews).where(eq(schema.previews.id, claimed.previewId))
    expect(row!.resources).toEqual(resources)
    expect(row!.cleanupCompletedAt).toBeNull()
    expect(await claimNextPreview(db)).toBeNull()
    await expect(admitPreview(db, claimed.buildId, owner, crypto.randomUUID())).rejects.toMatchObject({ status: 409 })
    await reconcilePreview(db, async (identity, ownedResources) => {
      expect(identity).toEqual({ previewId: claimed.previewId, projectId: claimed.projectId, buildId: claimed.buildId, token: claimed.token })
      expect(ownedResources).toEqual(resources)
    })
    await expect(updatePreviewProgress(db, claimed, { type: 'log', text: 'output after cleanup' })).rejects.toThrow()
    const replacement = await admitPreview(db, claimed.buildId, owner, crypto.randomUUID())
    expect(replacement.previewId).not.toBe(claimed.previewId)
  })
  test('lease renewal and status reads do not extend viewer expiry; expired state cannot revive', async () => {
    const claimed = await ready()
    const before = await getOwnedPreview(db, claimed.previewId, owner)
    await renewPreviewLease(db, claimed)
    expect((await getOwnedPreview(db, claimed.previewId, owner))!.expiresAt).toEqual(before!.expiresAt)
    expect(await touchPreviewViewer(db, claimed.previewId, owner)).toBe(true)
    await db.update(schema.previews).set({ expiresAt: new Date(0) }).where(eq(schema.previews.id, claimed.previewId))
    expect(await touchPreviewViewer(db, claimed.previewId, owner)).toBe(false)
    expect((await getOwnedPreview(db, claimed.previewId, owner))!.status).not.toBe('ready')
    await reconcilePreview(db, async () => {})
    expect((await getOwnedPreview(db, claimed.previewId, owner))!.status).toBe('expired')
  })
  test('expired execution is interrupted, not rerun; revocation survives failed cleanup', async () => {
    const claimed = await claim()
    await db.update(schema.previews).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.previews.id, claimed.previewId))
    await expect(reconcilePreview(db, async () => { throw new Error('Controlled cleanup failure') })).rejects.toThrow()
    expect((await getOwnedPreview(db, claimed.previewId, owner))!.status).toBe('interrupted')
    expect(await claimNextPreview(db)).toBeNull()
    let cleanups = 0
    await Promise.all([reconcilePreview(db, async () => { cleanups++ }), reconcilePreview(db, async () => { cleanups++ })])
    expect(cleanups).toBe(1)
    expect(await claimNextPreview(db)).toBeNull()
  })
  test('queued stop releases reservation without ever invoking resource cleanup', async () => {
    const id = await build()
    const admitted = await admitPreview(db, id, owner, crypto.randomUUID())
    await stopPreview(db, admitted.previewId, owner)
    expect((await getOwnedPreview(db, admitted.previewId, owner))!.cleanupPending).toBe(false)
    expect(await reconcilePreview(db, async () => { throw new Error('Must not run') })).toBe(false)
    expect(await claimNextPreview(db)).toBeNull()
  })
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Preview worker fixture timed out.'); await Bun.sleep(5) }
  }
  function workerConfiguration(): Parameters<typeof createPreviewWorkerDependencies>[1] {
    return { ingressBundle: new Uint8Array([1]), ingressFor: () => ({ previewOrigin: 'http://worker-preview.localhost:3003',
      controlOrigin: 'http://localhost:3000', capability: 'e'.repeat(64), blockedCookieNames: ['control-session'] }) }
  }
  function fakeAdapters(): PreviewRuntimeAdapters {
    return {
      start: async input => {
        input.onOutput?.('Persisted preview preparation log')
        await input.onStarted?.(resources, { imageId: 'sha256:' + 'f'.repeat(64), lockfileSha256: null })
        return { resources, ingressUrl: 'http://127.0.0.1:12345', imageId: 'sha256:' + 'f'.repeat(64), lockfileSha256: null, output: '' }
      }, cleanup: async () => {}, check: async () => {},
    }
  }
  test('worker persists preparation identity/logs, keeps ready alive and cleans after explicit stop', async () => {
    const id = await build()
    const admitted = await admitPreview(db, id, owner, crypto.randomUUID())
    await verifyPreviewWorkerSchema(db)
    let starts = 0
    const adapters = fakeAdapters()
    const start = adapters.start
    adapters.start = async input => { starts++; return start(input) }
    const shutdown = new AbortController()
    const done = runPreviewWorker(createPreviewWorkerDependencies(db, workerConfiguration(), adapters), shutdown.signal,
      { monitorIntervalMs: 20, pollIntervalMs: 5 })
    try {
      await waitFor(async () => (await getOwnedPreview(db, admitted.previewId, owner))?.status === 'ready')
      const [row] = await db.select().from(schema.previews).where(eq(schema.previews.id, admitted.previewId))
      expect(row!.resources!.preparation).toEqual({ imageId: 'sha256:' + 'f'.repeat(64), lockfileSha256: null })
      expect(row!.log).toContain('Persisted preview preparation log')
      await stopPreview(db, admitted.previewId, owner)
      await waitFor(async () => !(await getOwnedPreview(db, admitted.previewId, owner))?.cleanupPending)
      expect(starts).toBe(1)
      expect((await getOwnedPreview(db, admitted.previewId, owner))!.status).toBe('stopped')
    } finally { shutdown.abort(); await done }
  })
  test('stop during preparation quiesces outside cleanup locks and preserves partial diagnostics', async () => {
    const admitted = await admitPreview(db, await build(), owner, crypto.randomUUID())
    const adapters = fakeAdapters()
    let preparing = false
    adapters.start = async input => {
      input.onOutput?.('Partial output before stop')
      preparing = true
      await new Promise<void>(resolve => {
        if (input.signal?.aborted) resolve()
        else input.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('Controlled abort')
    }
    const shutdown = new AbortController()
    const done = runPreviewWorker(createPreviewWorkerDependencies(db, workerConfiguration(), adapters), shutdown.signal,
      { monitorIntervalMs: 20, pollIntervalMs: 5 })
    try {
      await waitFor(async () => preparing)
      await stopPreview(db, admitted.previewId, owner)
      await waitFor(async () => !(await getOwnedPreview(db, admitted.previewId, owner))?.cleanupPending)
      expect((await getOwnedPreview(db, admitted.previewId, owner))!.status).toBe('stopped')
      expect((await getOwnedPreview(db, admitted.previewId, owner))!.log).toContain('Partial output before stop')
    } finally { shutdown.abort(); await done }
  })
  test('worker shutdown interrupts ready runtime and releases reservation after cleanup', async () => {
    const admitted = await admitPreview(db, await build(), owner, crypto.randomUUID())
    const shutdown = new AbortController()
    const done = runPreviewWorker(createPreviewWorkerDependencies(db, workerConfiguration(), fakeAdapters()), shutdown.signal,
      { monitorIntervalMs: 20, pollIntervalMs: 5 })
    try { await waitFor(async () => (await getOwnedPreview(db, admitted.previewId, owner))?.status === 'ready') }
    finally { shutdown.abort(); await done }
    const snapshot = await getOwnedPreview(db, admitted.previewId, owner)
    expect(snapshot!.status).toBe('interrupted')
    expect(snapshot!.cleanupPending).toBe(false)
  })
  test('worker rejects unknown expired executor without cleaning or starting another operation', async () => {
    const claimed = await claim()
    await db.update(schema.previews).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.previews.id, claimed.previewId))
    const adapters = fakeAdapters()
    let effects = 0
    adapters.cleanup = async () => { effects++ }
    adapters.start = async () => { effects++; throw new Error('Must not start') }
    const dependencies = createPreviewWorkerDependencies(db, workerConfiguration(), adapters)
    let attempted = false
    const proof = dependencies.assertExternalQuiescent
    dependencies.assertExternalQuiescent = async claim => { attempted = true; await proof(claim) }
    const shutdown = new AbortController()
    const done = runPreviewWorker(dependencies, shutdown.signal, { monitorIntervalMs: 20, pollIntervalMs: 5 })
    void done.catch(() => {})
    await waitFor(async () => attempted)
    shutdown.abort()
    await expect(done).rejects.toThrow('could not confirm')
    expect(effects).toBe(0)
    expect((await getOwnedPreview(db, claimed.previewId, owner))!.cleanupPending).toBe(true)
  })
  const dockerTest = process.env.WRENLY_TEST_DOCKER === 'true' ? test : test.skip
  dockerTest('combined worker/PostgreSQL/Docker flow prepares, persists ready and stops a controlled app', async () => {
    const id = await build()
    await db.update(schema.builds).set({ files: [
      { path: 'package.json', content: JSON.stringify({ scripts: { build: 'bun build.js', start: 'bun app.js' } }) },
      { path: 'build.js', content: "await Bun.write('prepared.txt','prepared by preview worker')" },
      { path: 'app.js', content: "Bun.serve({hostname:'0.0.0.0',port:3000,async fetch(){return new Response(await Bun.file('prepared.txt').text())}})" },
    ] }).where(eq(schema.builds.id, id))
    const admitted = await admitPreview(db, id, owner, crypto.randomUUID())
    const bundled = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
    if (!bundled.success || !bundled.outputs[0]) throw new Error('Trusted ingress bundle failed.')
    const configuration = workerConfiguration()
    configuration.ingressBundle = new Uint8Array(await bundled.outputs[0].arrayBuffer())
    const shutdown = new AbortController()
    const done = runPreviewWorker(createPreviewWorkerDependencies(db, configuration), shutdown.signal,
      { monitorIntervalMs: 200, pollIntervalMs: 20 })
    try {
      await waitFor(async () => (await getOwnedPreview(db, admitted.previewId, owner))?.status === 'ready', 20_000)
      const snapshot = await getOwnedPreview(db, admitted.previewId, owner)
      expect(snapshot!.log).toContain('Revalidating preview source')
      const [row] = await db.select().from(schema.previews).where(eq(schema.previews.id, admitted.previewId))
      expect(row!.resources!.preparation!.imageId).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(row!.resources!.preparation!.lockfileSha256).toBeNull()
      await stopPreview(db, admitted.previewId, owner)
      await waitFor(async () => !(await getOwnedPreview(db, admitted.previewId, owner))?.cleanupPending, 10_000)
      expect((await getOwnedPreview(db, admitted.previewId, owner))!.status).toBe('stopped')
    } finally { shutdown.abort(); await done }
  }, 35_000)

  test('access grants are hashed/single use, sessions are owner-bound and stop revokes them', async () => {
    const claimed = await ready()
    await expect(issuePreviewGrant(db, claimed.previewId, foreignOwner, await controlSession(foreignOwner))).rejects.toMatchObject({ status: 404 })
    const grant = await issuePreviewGrant(db, claimed.previewId, owner, await controlSession())
    const outcomes = await Promise.all([consumePreviewGrant(db, claimed.previewId, grant), consumePreviewGrant(db, claimed.previewId, grant)])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    const token = outcomes.find(Boolean)!
    expect(await authorizePreviewSession(db, claimed.previewId, token)).toBe(owner)
    expect(await authorizePreviewSession(db, crypto.randomUUID(), token)).toBeNull()
    const [stored] = await db.select().from(schema.previewAccess).where(eq(schema.previewAccess.previewId, claimed.previewId))
    expect(stored!.grantHash).not.toBe(grant); expect(stored!.sessionHash).not.toBe(token)
    await stopPreview(db, claimed.previewId, owner)
    expect(await authorizePreviewSession(db, claimed.previewId, token)).toBeNull()
  })
  test('missing control sessions cannot issue or redeem historical grants', async () => {
    const claimed = await ready()
    await expect(issuePreviewGrant(db, claimed.previewId, owner, null)).rejects.toMatchObject({ status: 401 })
    const grant = await issuePreviewGrant(db, claimed.previewId, owner, await controlSession())
    await db.update(schema.previewAccess).set({ authSessionId: null }).where(eq(schema.previewAccess.previewId, claimed.previewId))
    expect(await consumePreviewGrant(db, claimed.previewId, grant)).toBeNull()
    const valid = await issuePreviewGrant(db, claimed.previewId, owner, await controlSession())
    const token = await consumePreviewGrant(db, claimed.previewId, valid)
    expect(token).not.toBeNull()
    await db.update(schema.previewAccess).set({ authSessionId: null }).where(eq(schema.previewAccess.previewId, claimed.previewId))
    expect(await authorizePreviewSession(db, claimed.previewId, token!)).toBeNull()
  })
  test('expired grant and removed control session deny gateway access', async () => {
    const claimed = await ready()
    const expired = await issuePreviewGrant(db, claimed.previewId, owner, await controlSession())
    await db.update(schema.previewAccess).set({ grantExpiresAt: new Date(0) }).where(eq(schema.previewAccess.previewId, claimed.previewId))
    expect(await consumePreviewGrant(db, claimed.previewId, expired)).toBeNull()
    const sessionId = crypto.randomUUID()
    await db.insert(schema.session).values({ id: sessionId, userId: owner, accessRevision:(await db.select().from(schema.user).where(eq(schema.user.id,owner)))[0]!.accessRevision, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) })
    const grant = await issuePreviewGrant(db, claimed.previewId, owner, sessionId)
    const token = await consumePreviewGrant(db, claimed.previewId, grant)
    expect(token).not.toBeNull()
    expect(await authorizePreviewSession(db, claimed.previewId, token!)).toBe(owner)
    await db.delete(schema.session).where(eq(schema.session.id, sessionId))
    expect(await authorizePreviewSession(db, claimed.previewId, token!)).toBeNull()
  })
  test('expired, deleted and stale-revision sessions cannot redeem a pending grant', async () => {
    const claimed = await ready()
    for (const change of ['expiry', 'deletion', 'revision'] as const) {
      const sessionId = await controlSession()
      const grant = await issuePreviewGrant(db, claimed.previewId, owner, sessionId)
      if (change === 'expiry') await db.update(schema.session).set({ expiresAt: new Date(0) }).where(eq(schema.session.id, sessionId))
      if (change === 'deletion') await db.delete(schema.session).where(eq(schema.session.id, sessionId))
      if (change === 'revision') await db.update(schema.session).set({ accessRevision: crypto.randomUUID() }).where(eq(schema.session.id, sessionId))
      expect(await consumePreviewGrant(db, claimed.previewId, grant)).toBeNull()
      await expect(issuePreviewGrant(db, claimed.previewId, owner, sessionId)).rejects.toMatchObject({ status: 401 })
    }
  })
  test('control handlers authorize ownership and return a fragment-only bootstrap link', async () => {
    const claimed = await ready()
    const sessionless = createPreviewHttpHandlers(db, { enabled: true, baseUrl: 'http://wrenly-preview.localhost:3003', user: async () => ({ id: owner, authSessionId: null }) })
    expect((await sessionless.access(new Request('http://localhost/api'), claimed.previewId)).status).toBe(401)
    expect((await sessionless.get(new Request('http://localhost/api'), claimed.buildId)).status).toBe(401)
    const handlers = createPreviewHttpHandlers(db, { enabled: true, baseUrl: 'http://wrenly-preview.localhost:3003', user: async () => ({ id: owner, authSessionId: await controlSession() }) })
    const response = await handlers.access(new Request('http://localhost/api'), claimed.previewId)
    expect(response.status).toBe(200)
    const body = await response.json()
    const url = new URL(body.url)
    expect(url.hostname).toBe(`${claimed.previewId}.wrenly-preview.localhost`)
    expect(url.search).toBe(''); expect(url.hash.length).toBe(65)
    const foreign = createPreviewHttpHandlers(db, { enabled: true, baseUrl: 'http://wrenly-preview.localhost:3003', user: async () => ({ id: foreignOwner, authSessionId: await controlSession(foreignOwner) }) })
    expect((await foreign.access(new Request('http://localhost/api'), claimed.previewId)).status).toBe(404)
    expect((await foreign.get(new Request('http://localhost/api'), claimed.buildId)).status).toBe(404)
    expect((await foreign.stop(new Request('http://localhost/api'), claimed.previewId)).status).toBe(404)
    expect((await handlers.get(new Request('http://localhost/api'), 'invalid')).status).toBe(400)
  })
  dockerTest('production preview lifecycle, gateway and control handlers serve and revoke a saved fixture', async () => {
    const id = await build()
    await db.update(schema.builds).set({ files: [
      { path: 'package.json', content: JSON.stringify({ scripts: { build: 'bun build.js', start: 'bun app.js' } }) },
      { path: 'build.js', content: "await Bun.write('prepared.txt','production preview fixture')" },
      { path: 'app.js', content: "Bun.serve({hostname:'0.0.0.0',port:3000,async fetch(){return new Response(await Bun.file('prepared.txt').text())}})" },
    ] }).where(eq(schema.builds.id, id))
    const bundled = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
    if (!bundled.success || !bundled.outputs[0]) throw new Error('Trusted ingress build failed.')
    let gateway: ReturnType<typeof createPreviewGateway>
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => gateway(request) })
    const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: testUrl, WRENLY_AUTH_SECRET: 'p'.repeat(32), WRENLY_APP_URL: 'http://localhost:3002',
      WRENLY_WEB_URL: 'http://localhost:3000', WRENLY_SINGLE_USER_MODE: 'true', WRENLY_PREVIEW_ENABLED: 'true',
      WRENLY_PREVIEW_BASE_URL: `http://wrenly-preview.localhost:${server.port}`, WRENLY_PREVIEW_GATEWAY_PORT: server.port })
    const worker = await startProductionPreviewWorker(db, environment, new Uint8Array(await bundled.outputs[0].arrayBuffer()))
    gateway = createPreviewGateway({ baseUrl: environment.WRENLY_PREVIEW_BASE_URL, controlOrigin: environment.WRENLY_WEB_URL,
      consume: (id, token) => consumePreviewGrant(db, id, token), authorize: (id, token) => authorizePreviewSession(db, id, token),
      touch: (id, userId) => touchPreviewViewer(db, id, userId), runtime: worker.runtime })
    const handlers = createPreviewHttpHandlers(db, { enabled: true, baseUrl: environment.WRENLY_PREVIEW_BASE_URL, user: async () => ({ id: owner, authSessionId: await controlSession() }) })
    try {
      const request = new Request('http://localhost/api', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() } })
      const admitted = await (await handlers.create(request, id)).json()
      await waitFor(async () => (await getOwnedPreview(db, admitted.previewId, owner))?.status === 'ready', 20_000)
      const link = new URL((await (await handlers.access(request, admitted.previewId)).json()).url)
      const base = `http://127.0.0.1:${server.port}`
      const access = await fetch(base + '/__wrenly/access', { method: 'POST', headers: { host: link.host, origin: link.origin, 'content-type': 'application/json' }, body: JSON.stringify({ grant: link.hash.slice(1) }) })
      expect(access.status).toBe(204)
      const cookie = access.headers.getSetCookie()[0]!.split(';')[0]!
      expect(cookie.startsWith(PREVIEW_COOKIE + '=')).toBe(true)
      expect(await (await fetch(base, { headers: { host: link.host, cookie } })).text()).toBe('production preview fixture')
      await handlers.stop(request, admitted.previewId)
      expect((await fetch(base, { headers: { host: link.host, cookie } })).status).toBe(401)
      await waitFor(async () => !(await getOwnedPreview(db, admitted.previewId, owner))?.cleanupPending, 10_000)
    } finally { await worker.stop(); await server.stop(true) }
  }, 40_000)

  dockerTest('crashed production executor is cleaned after lock release without rerunning preparation', async () => {
    const id = await build()
    await db.update(schema.builds).set({ files: [
      { path: 'package.json', content: JSON.stringify({ scripts: { build: 'bun build.js', start: 'bun app.js' } }) },
      { path: 'build.js', content: "await Bun.write('prepared.txt','crash fixture')" },
      { path: 'app.js', content: "Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response('crash fixture')}})" },
    ] }).where(eq(schema.builds.id, id))
    const admitted = await admitPreview(db, id, owner, crypto.randomUUID())
    const modulePath = resolve(import.meta.dir, '../../../../../apps/api/src/modules/previews/execution/production-preview-worker.ts')
    const script = `import {db} from ${JSON.stringify(resolve(import.meta.dir, '../../../src/connections/client.ts'))};import {startProductionPreviewWorker} from ${JSON.stringify(modulePath)};import {parseApiEnvironment} from ${JSON.stringify(resolve(import.meta.dir, '../../../../../apps/api/src/config/api-environment.ts'))};const result=await Bun.build({entrypoints:[${JSON.stringify(resolve(import.meta.dir, '../../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts'))}],target:'bun'});const environment=parseApiEnvironment({WRENLY_DATABASE_URL:process.env.WRENLY_DATABASE_URL,WRENLY_AUTH_SECRET:'x'.repeat(32),WRENLY_APP_URL:'http://localhost:3002',WRENLY_WEB_URL:'http://localhost:3000',WRENLY_SINGLE_USER_MODE:'true',WRENLY_PREVIEW_ENABLED:'true'});await startProductionPreviewWorker(db,environment,new Uint8Array(await result.outputs[0].arrayBuffer()));setInterval(()=>{},1000);`
    const child = Bun.spawn(['bun', '-e', script], { env: { ...process.env, WRENLY_DATABASE_URL: testUrl! }, stdout: 'ignore', stderr: 'ignore' })
    let recovery: Awaited<ReturnType<typeof startProductionPreviewWorker>> | undefined
    try {
      await waitFor(async () => (await getOwnedPreview(db, admitted.previewId, owner))?.status === 'ready', 20_000)
      child.kill('SIGKILL'); await child.exited
      // Accelerate the lease deadline only after proving the fixture API is dead.
      await db.update(schema.previews).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.previews.id, admitted.previewId))
      const bundled = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
      if (!bundled.success || !bundled.outputs[0]) throw new Error('Trusted ingress build failed.')
      const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: testUrl, WRENLY_AUTH_SECRET: 'x'.repeat(32), WRENLY_APP_URL: 'http://localhost:3002',
        WRENLY_WEB_URL: 'http://localhost:3000', WRENLY_SINGLE_USER_MODE: 'true', WRENLY_PREVIEW_ENABLED: 'true' })
      recovery = await startProductionPreviewWorker(db, environment, new Uint8Array(await bundled.outputs[0].arrayBuffer()))
      await waitFor(async () => !(await getOwnedPreview(db, admitted.previewId, owner))?.cleanupPending, 20_000)
      expect((await getOwnedPreview(db, admitted.previewId, owner))!.status).toBe('interrupted')
      expect((await db.select().from(schema.previews)).length).toBe(1)
    } finally {
      child.kill('SIGKILL'); await child.exited
      if (recovery) await recovery.stop()
    }
  }, 50_000)

  dockerTest('packaged API starts opt-in listeners, serves preview routes and awaits shutdown cleanup', async () => {
    const localUser = `packaged-user-${crypto.randomUUID()}`
    const fixtureEmail = `packaged-${crypto.randomUUID()}@example.test`
    const fixturePassword = 'fixture-preview-password'
    const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, localUser))
    if (existing) throw new Error('Disposable preview DB already contains a local-user fixture; do not modify unknown test data.')
    await db.insert(schema.user).values({ id: localUser, name: 'Packaged API fixture', email: fixtureEmail })
    await db.insert(schema.account).values({ id: crypto.randomUUID(), accountId: localUser, providerId: 'credential', userId: localUser, password: await hashFixturePassword(fixturePassword) })
    const projectId = crypto.randomUUID(); const buildId = crypto.randomUUID()
    await db.insert(schema.projects).values({ id: projectId, userId: localUser, name: 'Packaged API fixture', stack: 'nextjs' })
    await db.insert(schema.builds).values({ id: buildId, projectId, prompt: 'Controlled fixture', status: 'success', stack: 'nextjs', files: [
      { path: 'package.json', content: JSON.stringify({ scripts: { build: 'bun build.js', start: 'bun app.js' } }) },
      { path: 'build.js', content: "await Bun.write('prepared.txt','packaged preview fixture')" },
      { path: 'app.js', content: "Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response('packaged preview fixture')}})" },
    ] })
    const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const reserveGateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const apiPort = reserve.port!; const gatewayPort = reserveGateway.port!
    await reserve.stop(true); await reserveGateway.stop(true)
    const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, '../../../../../apps/api/dist/index.js')], { env: { ...process.env,
      WRENLY_DATABASE_URL: testUrl!, WRENLY_AUTH_SECRET: 'packaged-preview-fixture-secret-32-characters', WRENLY_SINGLE_USER_MODE: 'true',
      WRENLY_APP_URL: `http://localhost:${apiPort}`, WRENLY_API_PORT: String(apiPort), WRENLY_API_HOST: '127.0.0.1', WRENLY_PUBLISHING_ENABLED: 'false',
      WRENLY_WEB_URL: 'http://localhost:3000', WRENLY_PREVIEW_ENABLED: 'true', WRENLY_PREVIEW_GATEWAY_PORT: String(gatewayPort),
      WRENLY_PREVIEW_BASE_URL: `http://wrenly-preview.localhost:${gatewayPort}` }, stdout: 'ignore', stderr: 'ignore' })
    let previewId: string | undefined
    try {
      const api = `http://127.0.0.1:${apiPort}`
      await waitFor(async () => { try { return (await fetch(api + '/api/health')).ok } catch { return false } }, 10_000)
      const login = await fetch(api + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ email: fixtureEmail, password: fixturePassword }) })
      expect(login.status).toBe(200)
      const controlCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      expect(controlCookie.length).toBeGreaterThan(0)
      const admitted = await fetch(api + `/api/builds/${buildId}/preview`, { method: 'POST', headers: { cookie: controlCookie, 'idempotency-key': crypto.randomUUID(), origin: 'http://localhost:3000' } })
      expect(admitted.status).toBe(202)
      previewId = (await admitted.json()).previewId
      await waitFor(async () => {
        const response = await fetch(api + `/api/builds/${buildId}/preview`, { headers: { cookie: controlCookie } })
        return response.ok && (await response.json()).preview?.status === 'ready'
      }, 20_000)
      const link = new URL((await (await fetch(api + `/api/previews/${previewId}/access`, { method: 'POST', headers: { cookie: controlCookie, origin: 'http://localhost:3000' } })).json()).url)
      const access = await fetch(`http://127.0.0.1:${gatewayPort}/__wrenly/access`, { method: 'POST', headers: { host: link.host, origin: link.origin }, body: JSON.stringify({ grant: link.hash.slice(1) }) })
      expect(access.status).toBe(204)
      const cookie = access.headers.getSetCookie()[0]!.split(';')[0]!
      expect(await (await fetch(`http://127.0.0.1:${gatewayPort}/`, { headers: { host: link.host, cookie } })).text()).toBe('packaged preview fixture')
      child.kill('SIGTERM')
      expect(await child.exited).toBe(0)
      expect((await getOwnedPreview(db, previewId!, localUser))!.status).toBe('interrupted')
      expect((await getOwnedPreview(db, previewId!, localUser))!.cleanupPending).toBe(false)
    } finally {
      child.kill('SIGKILL'); await child.exited
      if (previewId) {
        const [row] = await db.select().from(schema.previews).where(eq(schema.previews.id, previewId))
        if (row?.claimToken) {
          const { cleanupPreviewRuntime } = await import('../../../../sandbox/src/previews/runtime')
          await cleanupPreviewRuntime({ previewId, projectId, buildId, claimToken: row.claimToken })
        }
      }
      await db.delete(schema.previews).where(eq(schema.previews.projectId, projectId))
      await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
      await db.delete(schema.user).where(eq(schema.user.id, localUser))
    }
  }, 40_000)

  test('runtime log observation deduplicates snapshots and retains failure diagnostics', async () => {
    const admitted = await admitPreview(db, await build(), owner, crypto.randomUUID())
    const adapters = fakeAdapters()
    let exited = false; let checks = 0
    adapters.logs = async () => exited ? '2026-10-16T00:00:01Z controlled runtime error\n' : '2026-10-16T00:00:00Z runtime ready\n'
    adapters.check = async () => { checks++; if (exited) throw new Error('Controlled runtime exited') }
    const shutdown = new AbortController()
    const done = runPreviewWorker(createPreviewWorkerDependencies(db, workerConfiguration(), adapters), shutdown.signal,
      { monitorIntervalMs: 20, pollIntervalMs: 5 })
    try {
      await waitFor(async () => checks >= 3)
      const before = (await getOwnedPreview(db, admitted.previewId, owner))!
      expect(before.log.split('runtime ready').length - 1).toBe(1)
      exited = true
      await waitFor(async () => (await getOwnedPreview(db, admitted.previewId, owner))?.status === 'failed')
      expect((await getOwnedPreview(db, admitted.previewId, owner))!.log).toContain('controlled runtime error')
    } finally { shutdown.abort(); await done }
  })

})
