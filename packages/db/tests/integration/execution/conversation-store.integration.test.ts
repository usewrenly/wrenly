// Explicit disposable database only; no application environment URL is read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, inArray } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import {
  admitConversationTurn, getConversationHistory, claimConversationTurn,
  completeConversationAnswer, renewConversationLease, interruptExpiredConversationTurn, getConversationTurnSnapshot,
} from '../../../../../apps/api/src/modules/conversations/persistence/conversation-store'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_admission_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Conversation tests require a disposable local wrenly_admission_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('PostgreSQL conversation persistence', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_admission_test')
  const db = drizzle(client, { schema })
  const owner = `conversation-test-${crypto.randomUUID()}`
  const dependencies = { db, defaultModel: 'saved-model', resolveProvider: () => ({ id: 'saved-provider' }) }
  async function project(): Promise<string> {
    const id = crypto.randomUUID()
    await db.insert(schema.projects).values({ id, userId: owner, name: 'Conversation fixture' })
    return id
  }
  const foreignOwner = `${owner}-foreign`
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({id:foreignOwner,name:'Foreign test account',email:`${foreignOwner}@example.test`})
    await db.insert(schema.user).values({ id: owner, name: 'Conversation test', email: `${owner}@example.test` })
  })
  afterAll(async () => {
    await db.delete(schema.user).where(eq(schema.user.id,foreignOwner))
    try {
      await db.delete(schema.conversations).where(inArray(schema.conversations.projectId, db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.userId, owner))))
      await db.delete(schema.user).where(eq(schema.user.id, owner))
    }
    finally { await client.end() }
  })
  test('concurrent duplicate admission freezes one message, revision and model without creating a build', async () => {
    const projectId = await project()
    const baseBuildId = crypto.randomUUID()
    await db.insert(schema.builds).values({ id: baseBuildId, projectId, prompt: 'Existing revision', status: 'success' })
    const key = crypto.randomUUID()
    const body = { message: 'Why did the older build fail?', mode: 'ask', baseBuildId }
    const results = await Promise.all([admitConversationTurn(projectId, owner, key, body, dependencies), admitConversationTurn(projectId, owner, key, body, dependencies)])
    expect(results[0]?.turnId).toBe(results[1]?.turnId)
    expect(results.filter(row => row.replayed)).toHaveLength(1)
    const turnId = results[0]!.turnId
    const [turn] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, turnId))
    expect(turn?.baseBuildId).toBe(baseBuildId)
    expect(turn?.model).toBe('saved-model')
    expect(turn?.provider).toBe('saved-provider')
    expect((await getConversationHistory(db, projectId, owner)).messages).toHaveLength(1)
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(1)
    await db.update(schema.conversationTurns).set({ status: 'cancelled' }).where(eq(schema.conversationTurns.id, turnId))
  })
  test('replay survives default/provider changes; conflicting keys and active project turns are rejected', async () => {
    const projectId = await project(); const key = crypto.randomUUID(); const body = { message: 'Discuss the layout' }
    const admitted = await admitConversationTurn(projectId, owner, key, body, dependencies)
    expect((await admitConversationTurn(projectId, owner, key, body, { ...dependencies, defaultModel: 'new-model', resolveProvider: () => { throw new Error('Offline') } })).turnId).toBe(admitted.turnId)
    await expect(admitConversationTurn(projectId, owner, key, { message: 'Different' }, dependencies)).rejects.toThrow('idempotency key')
    await expect(admitConversationTurn(projectId, owner, crypto.randomUUID(), body, dependencies)).rejects.toThrow('active conversation turn')
    await db.update(schema.conversationTurns).set({ status: 'cancelled' }).where(eq(schema.conversationTurns.id, admitted.turnId))
  })
  test('ownership, cross-project revisions and in-progress revisions fail without persistence', async () => {
    const projectId = await project(); const other = await project(); const baseBuildId = crypto.randomUUID()
    await db.insert(schema.builds).values({ id: baseBuildId, projectId: other, prompt: 'Other', status: 'success' })
    await expect(admitConversationTurn(projectId, foreignOwner, crypto.randomUUID(), { message: 'Hello' }, dependencies)).rejects.toThrow('Project not found')
    await expect(getConversationHistory(db, projectId, foreignOwner)).rejects.toThrow('Project not found')
    await expect(admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Change', baseBuildId }, dependencies)).rejects.toThrow('revision not found')
    await db.update(schema.builds).set({ projectId, status: 'generating' }).where(eq(schema.builds.id, baseBuildId))
    await expect(admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Change', baseBuildId }, dependencies)).rejects.toThrow('still in progress')
    expect((await getConversationHistory(db, projectId, owner)).conversationId).toBeNull()
  })
  test('provider failures roll back conversation creation', async () => {
    const projectId = await project()
    await expect(admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Hello' }, { ...dependencies, resolveProvider: () => { throw new Error('Unavailable') } })).rejects.toThrow('provider is unavailable')
    expect((await getConversationHistory(db, projectId, owner)).conversationId).toBeNull()
  })
  test('claimed Ask answer persists separately and history paginates without creating any build', async () => {
    const projectId = await project()
    await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Explain the failure', mode: 'ask' }, dependencies)
    const claim = await claimConversationTurn(db)
    expect(claim?.input.prompt).toBe('Explain the failure')
    if (!claim) throw new Error('Claim missing')
    expect(await renewConversationLease(db, claim)).toBe(true)
    await expect(completeConversationAnswer(db, { ...claim, token: crypto.randomUUID() }, { type: 'answer', content: 'Forged' })).rejects.toThrow('valid lease')
    await expect(completeConversationAnswer(db, claim, { type: 'propose_build', content: 'Build', prompt: 'Build' })).rejects.toThrow('Ask mode')
    await completeConversationAnswer(db, claim, { type: 'answer', content: 'The saved compiler error describes a missing import.' })
    const first = await getConversationHistory(db, projectId, owner, 0, 1)
    expect(first.messages[0]?.role).toBe('user'); expect(first.nextCursor).toBe(1)
    const second = await getConversationHistory(db, projectId, owner, first.nextCursor!, 1)
    expect(second.messages[0]?.role).toBe('assistant'); expect(second.nextCursor).toBeNull()
    expect(await db.select().from(schema.builds).where(eq(schema.builds.projectId, projectId))).toHaveLength(0)
    const events = await db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.turnId, claim.turnId)).orderBy(schema.conversationEvents.sequence)
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3])
    expect(events.at(-1)?.data.status).toBe('completed')
    const snapshot = await getConversationTurnSnapshot(db, claim.turnId, owner, 1)
    expect(snapshot.events.map(event => event.sequence)).toEqual([2, 3])
    expect(snapshot.cursor).toBe(3)
    expect(snapshot).not.toHaveProperty('claimToken')
    expect(snapshot).not.toHaveProperty('requestIdentity')
    const history = await getConversationHistory(db, projectId, owner)
    expect(history.turns[0]?.model).toBe('saved-model')
    expect(history.turns[0]).not.toHaveProperty('claimToken')
    expect(history.turns[0]).not.toHaveProperty('requestIdentity')
    await expect(getConversationTurnSnapshot(db, claim.turnId, foreignOwner)).rejects.toThrow('turn not found')
    expect((await getConversationTurnSnapshot(db, claim.turnId, owner, 3)).events).toHaveLength(0)
    await expect(completeConversationAnswer(db, claim, { type: 'answer', content: 'Duplicate' })).rejects.toThrow('valid lease')
  })
  test('expired executor cannot renew or write, and recovery never queues inference again', async () => {
    const projectId = await project()
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Clarify my idea' }, dependencies)
    const claim = await claimConversationTurn(db)
    expect(claim?.turnId).toBe(admitted.turnId)
    if (!claim) throw new Error('Claim missing')
    await db.update(schema.conversationTurns).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.conversationTurns.id, claim.turnId))
    expect(await renewConversationLease(db, claim)).toBe(false)
    await expect(completeConversationAnswer(db, claim, { type: 'answer', content: 'Late answer' })).rejects.toThrow('valid lease')
    expect(await interruptExpiredConversationTurn(db)).toBe(true)
    expect(await interruptExpiredConversationTurn(db)).toBe(false)
    expect(await claimConversationTurn(db)).toBeNull()
    const [turn] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, claim.turnId))
    expect(turn?.status).toBe('interrupted')
    expect((await getConversationHistory(db, projectId, owner)).messages.map(message => message.role)).toEqual(['user'])
  })

  test('distinct concurrent messages and concurrent claims admit one executor', async () => {
    const projectId = await project()
    const results = await Promise.allSettled([
      admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'First' }, dependencies),
      admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Second' }, dependencies),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const claims = await Promise.all([claimConversationTurn(db), claimConversationTurn(db)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claim = claims.find(Boolean)
    if (!claim) throw new Error('Claim missing')
    await completeConversationAnswer(db, claim, { type: 'clarify', content: 'Which change should we discuss?' })
  })
  test('invalid pagination and capacity exhaustion remain explicit', async () => {
    const projectId = await project()
    await expect(getConversationHistory(db, projectId, owner, -1)).rejects.toThrow('history cursor')
    await expect(getConversationHistory(db, projectId, owner, 0, 101)).rejects.toThrow('history cursor')
    const admitted = await admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Initial' }, dependencies)
    await db.update(schema.conversationTurns).set({ status: 'cancelled' }).where(eq(schema.conversationTurns.id, admitted.turnId))
    await db.update(schema.conversations).set({ turnCount: 1000 }).where(eq(schema.conversations.id, admitted.conversationId))
    await expect(admitConversationTurn(projectId, owner, crypto.randomUUID(), { message: 'Overflow' }, dependencies)).rejects.toThrow('history is full')
    expect((await getConversationHistory(db, projectId, owner)).messages).toHaveLength(1)
  })
  test('global queue capacity rejects admission atomically without an empty conversation', async () => {
    for (let index = 0; index < 20; index++) {
      await admitConversationTurn(await project(), owner, crypto.randomUUID(), { message: 'Queued question' }, dependencies)
    }
    const rejected = await project()
    await expect(admitConversationTurn(rejected, owner, crypto.randomUUID(), { message: 'Overflow' }, dependencies)).rejects.toThrow('queue is full')
    expect((await getConversationHistory(db, rejected, owner)).conversationId).toBeNull()
  })

})
