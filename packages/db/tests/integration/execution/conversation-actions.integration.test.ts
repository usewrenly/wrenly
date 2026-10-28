// Disposable PostgreSQL only; no model inference or generated code executes here.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, inArray } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { admitConversationTurn, claimConversationTurn, getConversationTurnSnapshot, cancelConversationTurn, getConversationHistory } from '../../../../../apps/api/src/modules/conversations/persistence/conversation-store'
import { admitConversationBuildAction, reconcileConversationBuild } from '../../../../../apps/api/src/modules/conversations/execution/conversation-actions'
import { admitBuild } from '../../../../../apps/api/src/modules/builds/admission/build-admission'
import { requestBuildCancellation } from '../../../../../apps/api/src/modules/builds/persistence/build-job-store'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_admission_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Conversation actions require disposable local wrenly_admission_test.')
}
const integration = testUrl ? describe : describe.skip
integration('atomic conversation build actions', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_admission_test')
  const db = drizzle(client, { schema })
  const owner = `conversation-action-${crypto.randomUUID()}`
  const settings = { defaultModel: 'frozen-model', resolveProvider: () => ({ id: 'frozen-provider' }) }
  const dependencies = { ...settings, db }
  const proposal = { type: 'propose_build', content: 'I will update the heading and validate the app.', prompt: 'Update the heading.' }
  async function fixture(mode = 'build', base = false): Promise<{ projectId: string; turnId: string; key: string; baseId: string | null }> {
    const projectId = crypto.randomUUID(); const baseId = base ? crypto.randomUUID() : null
    await db.insert(schema.projects).values({ id: projectId, userId: owner, name: 'Action fixture' })
    if (baseId) {
      await db.insert(schema.builds).values([
        { id: baseId, projectId, prompt: 'Selected older revision', status: 'success', files: [{ path: 'package.json', content: '{}' }, { path: 'keep.ts', content: 'Keep' }] },
        { projectId, prompt: 'Newest unrelated revision', status: 'success', files: [{ path: 'package.json', content: '{"latest":true}' }] },
      ])
    }
    const key = crypto.randomUUID()
    const admitted = await admitConversationTurn(projectId, owner, key, { message: 'Update the heading', mode, baseBuildId: baseId }, dependencies)
    return { projectId, turnId: admitted.turnId, key, baseId }
  }
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({ id: owner, name: 'Action test', email: `${owner}@example.test` })
  })
  afterAll(async () => {
    try {
      await db.delete(schema.conversations).where(inArray(schema.conversations.projectId, db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.userId, owner))))
      await db.delete(schema.user).where(eq(schema.user.id, owner))
    } finally { await client.end() }
  })
  test('a different saved actor is never replaced with the project owner', async () => {
    const f = await fixture('auto'), actor = owner + '-other'
    await db.insert(schema.user).values({ id: actor, name: 'Other actor', email: `${actor}@example.test` })
    try {
      await db.update(schema.conversationTurns).set({ actorId: actor }).where(eq(schema.conversationTurns.id, f.turnId))
      const claim = await claimConversationTurn(db)
      if (!claim) throw new Error('Claim missing')
      // Sharing remains closed: an ungranted actor must fail instead of spending as owner.
      await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toMatchObject({ status: 404 })
      expect(await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.projectId, f.projectId))).toHaveLength(0)
      expect(await db.select().from(schema.conversationActions).where(eq(schema.conversationActions.turnId, f.turnId))).toHaveLength(0)
    } finally {
      await db.delete(schema.conversations).where(eq(schema.conversations.projectId, f.projectId))
      await db.delete(schema.user).where(eq(schema.user.id, actor))
    }
  })
  test('duplicate decisions atomically create one action/build with frozen selected revision and settings', async () => {
    const f = await fixture('auto', true); const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    const results = await Promise.allSettled([admitConversationBuildAction(db, claim, proposal, settings), admitConversationBuildAction(db, claim, proposal, settings)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const actions = await db.select().from(schema.conversationActions).where(eq(schema.conversationActions.turnId, f.turnId))
    expect(actions).toHaveLength(1)
    const buildId = actions[0]!.buildId
    const [build] = await db.select().from(schema.builds).where(eq(schema.builds.id, buildId))
    const [job] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId))
    expect(build?.parentBuildId).toBe(f.baseId); expect(job?.input.model).toBe('frozen-model'); expect(job?.input.provider).toBe('frozen-provider')
    expect(job?.input.previousFiles.some(file => file.path === 'keep.ts')).toBe(true)
    expect(job?.idempotencyKey).not.toBe(f.key)
    expect(job?.userId).toBe(owner)
    const [turn] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, f.turnId))
    expect(turn?.actorId).toBe(owner)
    expect((await getConversationHistory(db, f.projectId, owner)).messages.map(message => message.actorId)).toEqual([owner, null])
    expect((await getConversationTurnSnapshot(db, f.turnId, owner)).buildId).toBe(buildId)
    expect((await getConversationHistory(db, f.projectId, owner)).messages.map(message => message.kind)).toEqual(['message', 'propose_build'])
    await cancelConversationTurn(db, f.turnId, owner); await reconcileConversationBuild(db)
  })
  test('post-admission proposal insertion failure rolls back build/job/action/events together', async () => {
    const f = await fixture(); const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    // Force an actual uniqueness failure after build insertion without a production fault hook.
    await db.update(schema.conversations).set({ nextMessageSequence: 1 }).where(eq(schema.conversations.id, claim.input.conversationId))
    await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toThrow('proposal could not be saved')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, f.projectId))).toHaveLength(0)
    expect(await db.select().from(schema.conversationActions).where(eq(schema.conversationActions.turnId, f.turnId))).toHaveLength(0)
    expect((await getConversationTurnSnapshot(db, f.turnId, owner)).status).toBe('running')
    await db.update(schema.conversations).set({ nextMessageSequence: 2 }).where(eq(schema.conversations.id, claim.input.conversationId))
    const buildId = await admitConversationBuildAction(db, claim, proposal, settings)
    expect(await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId))).toHaveLength(1)
    await cancelConversationTurn(db, f.turnId, owner); await reconcileConversationBuild(db)
  })
  test('Ask and stale claims cannot create an action or build', async () => {
    const f = await fixture('ask'); const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toThrow('Ask mode')
    await cancelConversationTurn(db, f.turnId, owner)
    await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toThrow('valid lease')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, f.projectId))).toHaveLength(0)
  })
  test('Plan persists as its own mode and cannot admit a proposed build', async () => {
    const f = await fixture('plan'); const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    expect(claim.input.mode).toBe('plan')
    await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toThrow('Plan mode')
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, f.projectId))).toHaveLength(0)
    expect(await db.select().from(schema.conversationActions).where(eq(schema.conversationActions.turnId, f.turnId))).toHaveLength(0)
    await cancelConversationTurn(db, f.turnId, owner)
  })
  test('an active direct build prevents an orphan conversation action', async () => {
    const f = await fixture(); const direct = await admitBuild({ projectId: f.projectId, prompt: 'Existing build' }, owner, crypto.randomUUID(), dependencies)
    const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toThrow('active build')
    expect(await db.select().from(schema.conversationActions).where(eq(schema.conversationActions.turnId, f.turnId))).toHaveLength(0)
    await cancelConversationTurn(db, f.turnId, owner); await requestBuildCancellation(db, direct.buildId, owner)
  })
  test('existing source requires explicit base revision instead of a full regeneration', async () => {
    const f = await fixture(); const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    await db.insert(schema.builds).values({ projectId: f.projectId, prompt: 'Existing source', status: 'success', files: [{ path: 'package.json', content: '{}' }] })
    await expect(admitConversationBuildAction(db, claim, proposal, settings)).rejects.toThrow('Select the revision')
    await cancelConversationTurn(db, f.turnId, owner)
  })
  test('post-commit reconciliation reports authoritative outcomes exactly once without re-admission or fake summaries', async () => {
    for (const outcome of ['success', 'failed', 'interrupted'] as const) {
      const f = await fixture(); const claim = await claimConversationTurn(db)
      if (!claim) throw new Error('Claim missing')
      const buildId = await admitConversationBuildAction(db, claim, proposal, settings)
      expect(await reconcileConversationBuild(db)).toBe(false)
      await db.update(schema.buildJobs).set({ status: outcome }).where(eq(schema.buildJobs.buildId, buildId))
      await db.update(schema.builds).set({ status: outcome === 'success' ? 'success' : 'failed', attemptCount: 2 }).where(eq(schema.builds.id, buildId))
      expect(await reconcileConversationBuild(db)).toBe(true); expect(await reconcileConversationBuild(db)).toBe(false)
      const snapshot = await getConversationTurnSnapshot(db, f.turnId, owner)
      expect(snapshot.status).toBe(outcome === 'success' ? 'completed' : outcome)
      expect(snapshot.events.map(event => event.type)).toEqual(['status', 'status', 'tool_call', 'tool_result', 'complete'])
      expect(snapshot.events.at(-2)?.data.outcome).toBe(outcome)
      expect((await getConversationHistory(db, f.projectId, owner)).messages).toHaveLength(2)
      expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, f.projectId))).toHaveLength(1)
    }
  })
  test('waiting-build cancellation uses durable build cancellation and preserves completed results', async () => {
    const f = await fixture(); const claim = await claimConversationTurn(db)
    if (!claim) throw new Error('Claim missing')
    const buildId = await admitConversationBuildAction(db, claim, proposal, settings)
    expect(await cancelConversationTurn(db, f.turnId, 'foreign-user')).toBe(false)
    expect(await cancelConversationTurn(db, f.turnId, owner)).toBe(true)
    expect((await getConversationTurnSnapshot(db, f.turnId, owner)).status).toBe('waiting_build')
    const [job] = await db.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId))
    expect(job?.status).toBe('cancelled')
    await reconcileConversationBuild(db)
    expect((await getConversationTurnSnapshot(db, f.turnId, owner)).status).toBe('cancelled')
    expect(await cancelConversationTurn(db, f.turnId, owner)).toBe(true)
    expect((await getConversationTurnSnapshot(db, f.turnId, owner)).cursor).toBe(5)
  })
})
