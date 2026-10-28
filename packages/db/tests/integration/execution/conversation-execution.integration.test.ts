// Trusted provider fixture + explicitly configured disposable PostgreSQL only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'path'
import { eq, inArray } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { admitConversationTurn, getConversationHistory, getConversationTurnSnapshot, cancelConversationTurn, claimConversationTurn, failConversationTurn, completeConversationAnswer } from '../../../../../apps/api/src/modules/conversations/persistence/conversation-store'
import { loadConversationContext } from '../../../../../apps/api/src/modules/conversations/execution/conversation-context'
import { startProductionConversationWorker, verifyConversationSchema } from '../../../../../apps/api/src/modules/conversations/execution/production-conversation-worker'
import { createConversationHttpHandlers } from '../../../../../apps/api/src/modules/conversations/http/http'
import { createApp } from '../../../../../apps/api/src/app'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_admission_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Conversation execution tests require the disposable local wrenly_admission_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('PostgreSQL and HTTP conversation execution', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_admission_test')
  const db = drizzle(client, { schema })
  const owner = `conversation-execution-${crypto.randomUUID()}`
  const dependencies = { db, defaultModel: 'ask-ok', resolveProvider: () => ({ id: 'env' }) }
  let provider: ReturnType<typeof Bun.serve>
  let api: ReturnType<typeof Bun.serve>
  let worker: Awaited<ReturnType<typeof startProductionConversationWorker>> | undefined
  let calls = 0
  const previousUrl = process.env.WRENLY_MODEL_BASE_URL
  const previousKey = process.env.WRENLY_MODEL_API_KEY

  async function project(): Promise<string> {
    const id = crypto.randomUUID()
    await db.insert(schema.projects).values({ id, userId: owner, name: 'Execution fixture' })
    return id
  }
  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20) }
    throw new Error('Conversation fixture timed out')
  }
  async function waitForStatus(id: string, status: string): Promise<void> {
    await waitFor(async () => (await getConversationTurnSnapshot(db, id, owner)).status === status)
  }
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({ id: owner, name: 'Conversation execution', email: `${owner}@example.test` })
    provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      calls++
      expect(new URL(request.url).pathname).toBe('/v1/chat/completions')
      expect(request.headers.get('authorization')).toBe('Bearer fixture-secret')
      const body = await request.json() as { model: string }
      if (body.model === 'ask-fail') return new Response('fixture-secret private stack trace', { status: 500 })
      if (body.model === 'ask-stall') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }), { headers: { 'Content-Type': 'application/json' } })
      const decision = body.model === 'build-proposal'
        ? { type: 'propose_build', content: 'I will build and validate the requested app.', prompt: 'Create a small task tracker.' }
        : { type: 'answer', content: 'The selected revision has a saved missing-import error.' }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
    } })
    process.env.WRENLY_MODEL_BASE_URL = `http://127.0.0.1:${provider.port}/v1`
    process.env.WRENLY_MODEL_API_KEY = 'fixture-secret'
    const handlers = createConversationHttpHandlers({
      userId: async headers => headers.get('authorization') === 'owner' ? owner : headers.get('authorization') === 'foreign' ? 'foreign-user' : null,
      admit: (id, userId, key, body) => admitConversationTurn(id, userId, key, body, dependencies),
      history: (id, userId, after, limit) => getConversationHistory(db, id, userId, after, limit),
      snapshot: (id, userId, after) => getConversationTurnSnapshot(db, id, userId, after),
      cancel: (id, userId) => cancelConversationTurn(db, id, userId),
    })
    const ok = async (): Promise<Response> => Response.json({ ok: true })
    const app = createApp({ conversations: handlers, listProjects: ok, createProject: ok, getProject: ok, deployProject: ok, getModels: ok, generate: ok, auth: ok }, { web: 'http://localhost:3000', api: 'http://localhost:3002' })
    api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) })
    await verifyConversationSchema(db)
  })
  afterAll(async () => {
    try {
      await worker?.stop()
      await api?.stop(true); await provider?.stop(true)
      if (previousUrl === undefined) delete process.env.WRENLY_MODEL_BASE_URL
      else process.env.WRENLY_MODEL_BASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.WRENLY_MODEL_API_KEY
      else process.env.WRENLY_MODEL_API_KEY = previousKey
      await db.delete(schema.conversations).where(inArray(schema.conversations.projectId, db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.userId, owner))))
      await db.delete(schema.user).where(eq(schema.user.id, owner))
    } finally { await client.end() }
  })
  test('actor-scoped replay never returns another actor’s matching request UUID', async () => {
    const projectId = await project(), key = crypto.randomUUID(), otherActor = owner + '-other'
    await db.insert(schema.user).values({ id: otherActor, name: 'Other actor', email: `${otherActor}@example.test` })
    try {
      const [conversation] = await db.insert(schema.conversations).values({ projectId }).returning()
      if (!conversation) throw new Error('Fixture conversation missing')
      const [other] = await db.insert(schema.conversationTurns).values({ conversationId: conversation.id, actorId: otherActor, idempotencyKey: key,
        requestIdentity: 'different actor request', mode: 'ask', prompt: 'Other request', model: 'ask-ok', provider: 'env', status: 'completed' }).returning()
      const request = { message: 'My request', mode: 'ask' }
      const admitted = await admitConversationTurn(projectId, owner, key, request, dependencies)
      expect(admitted.turnId).not.toBe(other?.id)
      expect(admitted.replayed).toBe(false)
      expect((await admitConversationTurn(projectId, owner, key, request, dependencies)).turnId).toBe(admitted.turnId)
      const [turn] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, admitted.turnId))
      expect(turn?.actorId).toBe(owner)
      expect((await getConversationHistory(db, projectId, owner)).messages[0]?.actorId).toBe(owner)
      await cancelConversationTurn(db, admitted.turnId, owner)
    } finally {
      await db.delete(schema.conversations).where(eq(schema.conversations.projectId, projectId))
      await db.delete(schema.user).where(eq(schema.user.id, otherActor))
    }
  })
  test('uses the selected old revision and persisted outcome, labels truncated diagnostics and supplies no source bodies', async () => {
    const projectId = await project(); const old = crypto.randomUUID(); const latest = crypto.randomUUID()
    await db.insert(schema.builds).values([
      { id: old, projectId, prompt: 'Old', status: 'failed', errorMessage: 'Missing import', buildLog: 'x'.repeat(13000), files: [{ path: 'app/page.tsx', content: 'private source body' }] },
      { id: latest, projectId, prompt: 'Newest', status: 'success' },
    ])
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Explain the old error', mode: 'ask', baseBuildId: old }, dependencies)
    const claim = await claimConversationTurn(db)
    expect(claim?.turnId).toBe(admitted.turnId)
    if (!claim) throw new Error('Claim missing')
    const context = await loadConversationContext(db, claim)
    expect(context.revision?.id).toBe(old); expect(context.revision?.status).toBe('failed')
    expect(context.revision?.diagnostics?.length).toBe(12000); expect(context.revision?.diagnosticsOmitted).toBe(true)
    expect(context.revision?.fileManifest).toEqual(['app/page.tsx'])
    expect(JSON.stringify(context)).not.toContain('private source body')
    await completeConversationAnswer(db, claim, { type: 'clarify', content: 'What should we inspect next?' })
  })
  test('oversized essential history fails explicitly before any provider call', async () => {
    const projectId = await project(); const before = calls
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Explain', mode: 'ask' }, dependencies)
    // Place earlier fixture history before the submitted user message without changing its text.
    await db.update(schema.conversationMessages).set({ sequence: 5 }).where(eq(schema.conversationMessages.turnId, admitted.turnId))
    await db.insert(schema.conversationMessages).values(Array.from({ length: 4 }, (_, index) => ({
      conversationId: admitted.conversationId, turnId: admitted.turnId, sequence: index + 1,
      role: 'assistant' as const, kind: 'answer', content: 'x'.repeat(16000),
    })))
    const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    await expect(loadConversationContext(db, claim)).rejects.toThrow('context budget')
    await failConversationTurn(db, claim, 'failed', 'Context budget exceeded.')
    expect(calls).toBe(before)
  })
  test('live HTTP admission and subscription cancellation do not own inference; reload reads the saved answer', async () => {
    const projectId = await project(); const key = crypto.randomUUID(); const before = calls
    const url = `http://127.0.0.1:${api.port}/api/projects/${projectId}/messages`
    const init = { method: 'POST', headers: { authorization: 'owner', 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Explain the build', mode: 'ask' }) }
    const admittedResponse = await fetch(url, init)
    expect(admittedResponse.status).toBe(202)
    const admitted = await admittedResponse.json() as { turnId: string }
    const stream = await fetch(`http://127.0.0.1:${api.port}/api/conversation-turns/${admitted.turnId}/events`, { headers: { authorization: 'owner' } })
    await stream.body?.cancel()
    worker = await startProductionConversationWorker(db, 30)
    await waitForStatus(admitted.turnId, 'completed')
    expect(calls - before).toBe(1)
    const replay = await fetch(url, init); expect(replay.status).toBe(200)
    expect((await replay.json() as { turnId: string }).turnId).toBe(admitted.turnId)
    const history = await fetch(url, { headers: { authorization: 'owner' } })
    const saved = await history.json() as Awaited<ReturnType<typeof getConversationHistory>>
    expect(saved.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(saved.latestTurn?.id).toBe(admitted.turnId); expect(saved.latestTurn?.status).toBe('completed')
    const replayEvents = await fetch(`http://127.0.0.1:${api.port}/api/conversation-turns/${admitted.turnId}/events?after=1`, { headers: { authorization: 'owner' } })
    const text = await replayEvents.text(); expect(text).toContain('event: complete'); expect(text).not.toContain('id: 1\n')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(0)
    await worker.stop(); worker = undefined
  }, 10000)
  test('production Build reconciliation continues while another inference is active', async () => {
    const projectId = await project(); const before = calls
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Build a task tracker', mode: 'build', model: 'build-proposal' }, dependencies)
    worker = await startProductionConversationWorker(db, 30)
    await waitForStatus(admitted.turnId, 'waiting_build')
    const snapshot = await getConversationTurnSnapshot(db, admitted.turnId, owner)
    expect(snapshot.buildId).toBeTruthy()
    expect(await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.projectId, projectId))).toHaveLength(1)
    expect((await getConversationHistory(db, projectId, owner)).messages.at(-1)?.kind).toBe('propose_build')
    const otherProject = await project()
    const other = await admitConversationTurn(otherProject, owner, crypto.randomUUID(), { message: 'Slow unrelated question', mode: 'ask', model: 'ask-stall' }, dependencies)
    await waitFor(async () => calls - before === 2)
    await cancelConversationTurn(db, admitted.turnId, owner)
    await waitForStatus(admitted.turnId, 'cancelled')
    expect((await getConversationTurnSnapshot(db, other.turnId, owner)).status).toBe('running')
    expect(calls - before).toBe(2)
    expect((await getConversationTurnSnapshot(db, admitted.turnId, owner)).events.at(-2)?.type).toBe('tool_result')
    await worker.stop(); worker = undefined
  }, 10000)
  test('provider failures save a safe outcome, preserve the user message and never fabricate an assistant answer', async () => {
    const projectId = await project(); const before = calls
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Explain', mode: 'ask', model: 'ask-fail' }, dependencies)
    worker = await startProductionConversationWorker(db, 30)
    await waitForStatus(admitted.turnId, 'failed')
    expect(calls - before).toBe(1)
    const snapshot = await getConversationTurnSnapshot(db, admitted.turnId, owner)
    expect(snapshot.errorMessage).toContain('provider rejected')
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret')
    expect((await getConversationHistory(db, projectId, owner)).messages.map(message => message.role)).toEqual(['user'])
    await worker.stop(); worker = undefined
  }, 10000)
  test('shutdown aborts in-flight inference and persists interrupted without silently rerunning it', async () => {
    const projectId = await project(); const before = calls
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Slow question', mode: 'ask', model: 'ask-stall' }, dependencies)
    worker = await startProductionConversationWorker(db, 30)
    await waitFor(async () => calls > before)
    await worker.stop(); worker = undefined
    await waitForStatus(admitted.turnId, 'interrupted')
    worker = await startProductionConversationWorker(db, 30)
    await Bun.sleep(50)
    expect(calls - before).toBe(1)
    await worker.stop(); worker = undefined
  }, 10000)
  const processTest = process.env.WRENLY_TEST_MCP === 'true' ? test : test.skip
  processTest('hard API process death recovers an expired claim without repeating inference', async () => {
    const projectId = await project(); const before = calls
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Crash recovery', mode: 'ask', model: 'ask-stall' }, dependencies)
    const script = `import {db} from ${JSON.stringify(resolve(import.meta.dir, '../../../src/connections/client.ts'))};import {startProductionConversationWorker} from ${JSON.stringify(resolve(import.meta.dir, '../../../../../apps/api/src/modules/conversations/execution/production-conversation-worker.ts'))};const worker=await startProductionConversationWorker(db,30);await worker.done;`
    const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, WRENLY_DATABASE_URL: testUrl! }, stdout: 'ignore', stderr: 'ignore' })
    try {
      await waitFor(async () => calls > before)
      child.kill('SIGKILL'); await child.exited
      expect((await getConversationTurnSnapshot(db, admitted.turnId, owner)).status).toBe('running')
      // Advance only the disposable fixture lease instead of making the suite wait 30 seconds.
      await db.update(schema.conversationTurns).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.conversationTurns.id, admitted.turnId))
      worker = await startProductionConversationWorker(db, 30)
      await waitForStatus(admitted.turnId, 'interrupted')
      await Bun.sleep(50); expect(calls - before).toBe(1)
      await worker.stop(); worker = undefined
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
  }, 10000)
  test('explicit cancellation fences running inference; late failure cannot replace cancelled or completed results', async () => {
    const projectId = await project()
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Cancel', mode: 'ask' }, dependencies)
    const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    expect(await cancelConversationTurn(db, admitted.turnId, 'foreign-user')).toBe(false)
    expect(await cancelConversationTurn(db, admitted.turnId, owner)).toBe(true)
    expect(await cancelConversationTurn(db, admitted.turnId, owner)).toBe(true)
    await expect(failConversationTurn(db, claim, 'failed', 'Late failure')).rejects.toThrow('valid lease')
    expect((await getConversationTurnSnapshot(db, admitted.turnId, owner)).status).toBe('cancelled')
    expect((await getConversationHistory(db, projectId, owner)).messages).toHaveLength(1)
  })
  test('foreign history, snapshot, events and cancellation are denied by the live router', async () => {
    const projectId = await project()
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Private question', mode: 'ask' }, dependencies)
    for (const path of [`/api/projects/${projectId}/messages`, `/api/conversation-turns/${admitted.turnId}`, `/api/conversation-turns/${admitted.turnId}/events`]) {
      const response = await fetch(`http://127.0.0.1:${api.port}${path}`, { headers: { authorization: 'foreign' } })
      expect(response.status).toBe(404); expect(await response.text()).not.toContain('Private question')
    }
    const response = await fetch(`http://127.0.0.1:${api.port}/api/conversation-turns/${admitted.turnId}/cancel`, { method: 'POST', headers: { authorization: 'foreign' } })
    expect(response.status).toBe(404)
    await cancelConversationTurn(db, admitted.turnId, owner)
  })
})
