import { getSetupSummary } from '../../../../../apps/api/src/modules/auth/setup/setup-summary'
import { admitBuild } from '../../../../../apps/api/src/modules/builds/admission/build-admission'
import { admitConversationTurn, claimConversationTurn } from '../../../../../apps/api/src/modules/conversations/persistence/conversation-store'
import { loadConversationContext } from '../../../../../apps/api/src/modules/conversations/execution/conversation-context'
import { inferConversationDecision } from '../../../../../apps/api/src/modules/conversations/execution/conversation-model'
import { resolveInferenceSelection, resolveExecutionProvider, savedProviderIdentity } from '../../../../../apps/api/src/modules/models/selection/saved-providers'
import { createInferenceFetch } from '../../../../inference/src/index'
import { createProviderConfigurationService } from '../../../../../apps/api/src/modules/models/configuration/provider-configuration-service'
import { createProviderConfigurationHandlers } from '../../../../../apps/api/src/modules/models/configuration/provider-configuration-http'
import { getAvailableCatalog } from '../../../../../apps/api/src/modules/models/catalog/provider-catalog-store'
import { resolveProviderDestination } from '../../../../../apps/api/src/modules/models/transport/provider-destination'
import { readProviderModelList } from '../../../../../apps/api/src/modules/models/transport/provider-probe'
// Uses a disposable local database and temporary key directory for encrypted provider acceptance.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, rename, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import { createProviderConnection, updateProviderConnection, listProviderConnections, saveInstanceModelDefault, resolveSavedProviderConnection, assertProviderConfigurationOwner, getInstanceModelDefault } from '../../../../../apps/api/src/modules/models/configuration/provider-connection-store'
const url = process.env.WRENLY_TEST_PROVIDER_DATABASE_URL
if (url) { const parsed = new URL(url); if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/wrenly_provider_test') throw new Error('Use only a disposable local wrenly_provider_test database.') }
const integration = url ? describe : describe.skip
integration('encrypted provider connection persistence', () => {
  const client = postgres(url ?? 'postgresql://localhost/wrenly_provider_test', { onnotice: () => {} })
  const database = drizzle(client, { schema })
  let directory = ''
  beforeAll(async () => { await migrate(database, { migrationsFolder: `${import.meta.dir}/../../../migrations` }); directory = await mkdtemp(join(tmpdir(), 'wrenly-provider-storage-')) })
  // Explicitly clear project history before users: author references deliberately restrict deletion.
  afterEach(async () => { await database.delete(schema.projects); await database.delete(schema.instanceModelDefault); await database.delete(schema.providerConnectionAudit); await database.delete(schema.providerConnections); await database.delete(schema.instanceSetup); await database.delete(schema.user); await rm(join(directory, 'private'), { recursive: true, force: true }) })
  afterAll(async () => { await client.end(); if (directory) await rm(directory, { recursive: true, force: true }) })
  async function fixture(): Promise<string> {
    await database.insert(schema.user).values([{ id: 'owner', email: 'owner@example.test', name: 'Owner' }, { id: 'member', email: 'member@example.test', name: 'Member' }])
    await database.insert(schema.instanceSetup).values({ id: 1, ownerId: 'owner' })
    return join(directory, 'private')
  }
  const input = { label: 'Fixture cloud', protocol: 'openai-compatible', kind: 'cloud', endpoint: 'https://provider.example/v1', token: 'fixture-provider-token' }
  test('owner creates encrypted connections; safe metadata excludes secrets and endpoint identity stays immutable', async () => {
    const path = await fixture()
    await expect(createProviderConnection(database, 'member', input, path)).rejects.toThrow('Only the instance owner')
    const saved = await createProviderConnection(database, 'owner', input, path)
    const [stored] = await database.select().from(schema.providerConnections)
    expect(JSON.stringify(stored)).not.toContain(input.token)
    expect((await resolveSavedProviderConnection(database, saved.id, path)).token).toBe(input.token)
    const metadata = await listProviderConnections(database, 'owner')
    expect(metadata[0]?.tokenConfigured).toBe(true); expect(JSON.stringify(metadata)).not.toContain('ciphertext'); expect(JSON.stringify(metadata)).not.toContain(input.token)
    await expect(listProviderConnections(database, 'member')).rejects.toThrow('Only the instance owner')
    await expect(updateProviderConnection(database, 'owner', { id: saved.id, endpoint: 'https://changed.example/v1' }, path)).rejects.toThrow('new connection')
    await updateProviderConnection(database, 'owner', { id: saved.id, token: '', label: 'Renamed' }, path)
    expect((await resolveSavedProviderConnection(database, saved.id, path)).token).toBe(input.token)
    await updateProviderConnection(database, 'owner', { id: saved.id, token: 'replacement-token' }, path)
    const resolved = await resolveSavedProviderConnection(database, saved.id, path)
    expect(resolved.token).toBe('replacement-token'); expect(resolved.version).toBe(saved.version); expect(resolved.endpoint).toBe(input.endpoint)
    expect(JSON.stringify(await database.select().from(schema.providerConnectionAudit))).not.toContain('replacement-token')
  })
  test('defaults require owner and enabled connections; disabling never silently reroutes lookup', async () => {
    const path = await fixture(), saved = await createProviderConnection(database, 'owner', input, path)
    await expect(saveInstanceModelDefault(database, 'member', { connectionId: saved.id, modelId: 'served-model' })).rejects.toThrow('Only the instance owner')
    await saveInstanceModelDefault(database, 'owner', { connectionId: saved.id, modelId: 'served-model' })
    expect((await database.select().from(schema.instanceModelDefault))[0]?.modelId).toBe('served-model')
    await updateProviderConnection(database, 'owner', { id: saved.id, enabled: false }, path)
    await expect(resolveSavedProviderConnection(database, saved.id, path)).rejects.toThrow('disabled')
    await expect(saveInstanceModelDefault(database, 'owner', { connectionId: saved.id, modelId: 'another-model' })).rejects.toThrow('enabled')
    expect((await database.select().from(schema.instanceModelDefault))[0]?.modelId).toBe('served-model')
  })
  test('missing keys cannot be regenerated for saved ciphertext, while token-free local storage still works', async () => {
    const path = await fixture(), saved = await createProviderConnection(database, 'owner', input, path)
    const original = await readFile(join(path, 'provider-key'))
    await rename(join(path, 'provider-key'), join(path, 'original-key'))
    await expect(resolveSavedProviderConnection(database, saved.id, path)).rejects.toThrow('missing')
    await expect(createProviderConnection(database, 'owner', { ...input, label: 'Second' }, path)).rejects.toThrow('missing')
    expect(await database.select().from(schema.providerConnections)).toHaveLength(1)
    const local = await createProviderConnection(database, 'owner', { label: 'Local', protocol: 'ollama', kind: 'local', endpoint: 'http://localhost:11434' }, path)
    expect((await resolveSavedProviderConnection(database, local.id, path)).token).toBeNull()
    await rename(join(path, 'original-key'), join(path, 'provider-key'))
    expect((await readFile(join(path, 'provider-key'))).equals(original)).toBe(true)
    expect((await resolveSavedProviderConnection(database, saved.id, path)).token).toBe(input.token)
    await writeFile(join(path, 'provider-key'), Buffer.alloc(32))
    await expect(createProviderConnection(database, 'owner', { ...input, label: 'Wrong key' }, path)).rejects.toThrow('cannot be decrypted')
    expect(await database.select().from(schema.providerConnections)).toHaveLength(2)
  })
  test('ciphertext cannot be transplanted to a different connection', async () => {
    const path = await fixture(), first = await createProviderConnection(database, 'owner', input, path)
    const second = await createProviderConnection(database, 'owner', { ...input, label: 'Second' }, path)
    const [stored] = await database.select().from(schema.providerConnections).where(eq(schema.providerConnections.id, first.id))
    await database.update(schema.providerConnections).set({ credential: stored!.credential }).where(eq(schema.providerConnections.id, second.id))
    await expect(resolveSavedProviderConnection(database, second.id, path)).rejects.toThrow('cannot be decrypted')
  })
  test('creation request identity acknowledges exact retry without duplicate credentials or audit', async () => {
    const path = await fixture(), requestId = crypto.randomUUID()
    const settings = { ...input, requestId }
    const results = await Promise.all([createProviderConnection(database, 'owner', settings, path), createProviderConnection(database, 'owner', settings, path)])
    expect(results[0]?.id).toBe(results[1]?.id)
    expect(await database.select().from(schema.providerConnections)).toHaveLength(1)
    expect(await database.select().from(schema.providerConnectionAudit)).toHaveLength(1)
    await expect(createProviderConnection(database, 'owner', { ...settings, token: 'different-token' }, path)).rejects.toThrow('different connection settings')
    expect((await resolveSavedProviderConnection(database, results[0]!.id, path)).token).toBe(input.token)
  })

  test('connected owner HTTP service saves, probes and disables encrypted connections without exposing credentials', async () => {
    const path = await fixture()
    let calls = 0, observedToken = ''
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request): Response { calls++; observedToken = request.headers.get('authorization') ?? ''; return Response.json({ data: [{ id: 'fixture-served-model' }] }) } })
    try {
      const service = createProviderConfigurationService({ owner: actorId => assertProviderConfigurationOwner(database, actorId), catalog: () => getAvailableCatalog(database),
        list: actorId => listProviderConnections(database, actorId), getDefault: actorId => getInstanceModelDefault(database, actorId),
        create: (actorId, input) => createProviderConnection(database, actorId, input, path), update: (actorId, input) => updateProviderConnection(database, actorId, input, path),
        saveDefault: (actorId, input) => saveInstanceModelDefault(database, actorId, input), resolve: id => resolveSavedProviderConnection(database, id, path), destination: resolveProviderDestination, probe: readProviderModelList })
      let actor = 'owner'
      const handlers = createProviderConfigurationHandlers({ webUrl: 'http://localhost:3000', session: async () => actor, service })
      const request = (body: unknown): Request => new Request('http://localhost:3002/api/models/connections', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const created = await handlers.create(request({ source: 'custom', requestId: crypto.randomUUID(), label: 'HTTP fixture', kind: 'local', endpoint: server.url.origin, token: 'fixture-http-token' }))
      expect(created.status).toBe(200)
      const saved = await created.json() as { id: string }
      expect(calls).toBe(0)
      const metadata = await handlers.list(new Request('http://localhost:3002/api/models/connections'))
      const serialized = await metadata.text()
      expect(serialized).not.toContain('fixture-http-token'); expect(serialized).not.toContain('ciphertext')
      const probe = await handlers.probe(request({ id: saved.id }))
      expect(await probe.json()).toMatchObject({ state: 'ready', models: ['fixture-served-model'] })
      expect(observedToken).toBe('Bearer fixture-http-token')
      expect((await handlers.saveDefault(request({ connectionId: saved.id, modelId: 'fixture-served-model' }))).status).toBe(200)
      expect(await getInstanceModelDefault(database, 'owner')).toEqual({ connectionId: saved.id, modelId: 'fixture-served-model' })
      actor = 'member'
      expect((await handlers.probe(request({ id: saved.id }))).status).toBe(403)
      actor = 'owner'
      expect((await handlers.update(request({ id: saved.id, enabled: false }))).status).toBe(200)
      expect((await handlers.probe(request({ id: saved.id }))).status).toBe(409)
      expect(calls).toBe(1)
    } finally { await server.stop(true) }
  })

  test('new admissions freeze saved provider/model while changed defaults and rotated tokens cannot reroute queued work', async () => {
    const path = await fixture()
    let observedModel = '', observedToken = ''
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
      const body = await request.json() as { model: string }; observedModel = body.model; observedToken = request.headers.get('authorization') ?? ''
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'answer', content: 'Fixture answer' }) } }] })
    } })
    try {
      const first = await createProviderConnection(database, 'owner', { label: 'First', protocol: 'openai-compatible', kind: 'local', endpoint: server.url.origin + '/v1', token: 'first-token' }, path)
      const second = await createProviderConnection(database, 'owner', { label: 'Second', protocol: 'openai-compatible', kind: 'local', endpoint: server.url.origin + '/v1', token: 'second-token' }, path)
      await saveInstanceModelDefault(database, 'owner', { connectionId: first.id, modelId: 'first-model' })
      const dependencies = { db: database, defaultModel: 'must-not-be-used', resolveProvider: (): { id: string } => { throw new Error('Synchronous legacy resolver must not own saved settings') } }
      // Adapt the shared selection resolver to the admission callback argument order.
      const selection = (provider: string | undefined, model: string | undefined, tx: Parameters<typeof resolveInferenceSelection>[0]): ReturnType<typeof resolveInferenceSelection> => resolveInferenceSelection(tx, provider, model)
      const build = await admitBuild({ projectId: crypto.randomUUID(), prompt: 'Build fixture' }, 'owner', crypto.randomUUID(), { ...dependencies, resolveSelection: selection })
      const projectId = crypto.randomUUID()
      await database.insert(schema.projects).values({ id: projectId, userId: 'owner', name: 'Conversation fixture' })
      const conversation = await admitConversationTurn(projectId, 'owner', crypto.randomUUID(), { message: 'Explain the plan', mode: 'plan' }, { ...dependencies, resolveSelection: selection })
      await saveInstanceModelDefault(database, 'owner', { connectionId: second.id, modelId: 'second-model' })
      const [job] = await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, build.buildId))
      expect(job?.input.provider).toBe(savedProviderIdentity(first.id, first.version)); expect(job?.input.model).toBe('first-model')
      expect(JSON.stringify(job)).not.toContain('first-token')
      const [turn] = await database.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, conversation.turnId))
      expect(turn?.provider).toBe(job?.input.provider); expect(turn?.model).toBe('first-model')
      expect(await resolveInferenceSelection(database, undefined, undefined)).toEqual({ provider: savedProviderIdentity(second.id, second.version), model: 'second-model' })
      await expect(resolveInferenceSelection(database, savedProviderIdentity(first.id, first.version), undefined)).rejects.toThrow('Choose a model')
      await database.update(schema.builds).set({ status: 'failed' }).where(eq(schema.builds.id, build.buildId))
      await database.update(schema.buildJobs).set({ status: 'failed' }).where(eq(schema.buildJobs.buildId, build.buildId))
      const retry = await admitBuild({ projectId: job!.projectId, retryBuildId: build.buildId }, 'owner', crypto.randomUUID(), { ...dependencies, resolveSelection: selection })
      const [retryJob] = await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, retry.buildId))
      expect(retryJob?.input.provider).toBe(job?.input.provider)
      expect(retryJob?.input.model).toBe('first-model')
      await updateProviderConnection(database, 'owner', { id: first.id, token: 'rotated-first-token' }, path)
      const provider = await resolveExecutionProvider(database, turn!.provider, path)
      expect(provider.apiKey).toBe('rotated-first-token')
      const claim = await claimConversationTurn(database)
      expect(claim?.turnId).toBe(conversation.turnId)
      const context = await loadConversationContext(database, claim!)
      const decision = await inferConversationDecision({ context, model: claim!.input.model, mode: claim!.input.mode }, provider, new AbortController().signal, createInferenceFetch({ baseUrl: provider.baseUrl, kind: provider.networkScope! }))
      expect(decision).toEqual({ type: 'answer', content: 'Fixture answer' })
      expect(observedModel).toBe('first-model'); expect(observedToken).toBe('Bearer rotated-first-token')
      await updateProviderConnection(database, 'owner', { id: first.id, enabled: false }, path)
      await expect(resolveExecutionProvider(database, turn!.provider, path)).rejects.toThrow('no fallback')
      await expect(resolveExecutionProvider(database, savedProviderIdentity(second.id, crypto.randomUUID()), path)).rejects.toThrow('no fallback')
    } finally { await server.stop(true) }
  })

  test('concurrent environment imports copy once and disabled imports block legacy inference without losing encrypted credentials', async () => {
    const path = await fixture()
    const importing = { ...input, requestId: crypto.randomUUID(), envSourceId: 'ollama', protocol: 'ollama', kind: 'local', endpoint: 'http://localhost:11434', token: 'imported-fixture-token' }
    const [first, replay] = await Promise.all([createProviderConnection(database, 'owner', importing, path), createProviderConnection(database, 'owner', { ...importing, requestId: crypto.randomUUID() }, path)])
    expect(first).toEqual(replay)
    expect(await database.select().from(schema.providerConnections)).toHaveLength(1)
    expect((await listProviderConnections(database, 'owner'))[0]?.envSourceId).toBe('ollama')
    await updateProviderConnection(database, 'owner', { id: first.id, token: 'rotated-import-token', enabled: false }, path)
    await expect(resolveInferenceSelection(database, 'ollama', 'fixture-model')).rejects.toThrow('no legacy fallback')
    await expect(resolveExecutionProvider(database, 'ollama', path)).rejects.toThrow('no fallback')
    await createProviderConnection(database, 'owner', { ...importing, token: 'changed-environment-token', requestId: crypto.randomUUID() }, path)
    const [row] = await database.select().from(schema.providerConnections)
    expect(row?.enabled).toBe(false)
    await updateProviderConnection(database, 'owner', { id: first.id, enabled: true }, path)
    expect((await resolveSavedProviderConnection(database, first.id, path)).token).toBe('rotated-import-token')
    await expect(createProviderConnection(database, 'owner', { ...importing, endpoint: 'http://localhost:11435' }, path)).rejects.toThrow('another destination')
    await expect(createProviderConnection(database, 'member', importing, path)).rejects.toThrow('Only the instance owner')
    expect(JSON.stringify(await database.select().from(schema.providerConnectionAudit))).not.toContain('rotated-import-token')
  })

  test('setup summary scopes project progress to its session and exposes configuration without secrets or health claims', async () => {
    const path = await fixture()
    const saved = await createProviderConnection(database, 'owner', { label: 'Summary local', protocol: 'ollama', kind: 'local', endpoint: 'http://localhost:11434', token: 'summary-fixture-token' }, path)
    await saveInstanceModelDefault(database, 'owner', { connectionId: saved.id, modelId: 'summary-model' })
    await database.insert(schema.projects).values({ userId: 'owner', name: 'Owner private project' })
    const configuration = { previewEnabled: true, publishingEnabled: false }
    const owner = await getSetupSummary(database, 'owner', configuration)
    const member = await getSetupSummary(database, 'member', configuration)
    expect(owner.role).toBe('owner'); expect(owner.hasProjects).toBe(true)
    expect(member.role).toBe('user'); expect(member.hasProjects).toBe(false)
    expect(member.defaultModel).toMatchObject({ state: 'configured', modelId: 'summary-model', providerLabel: 'Summary local' })
    expect(member.connectionHealth).toBe('not-checked'); expect(member.preview).toBe('enabled')
    expect(JSON.stringify(member)).not.toContain('summary-fixture-token'); expect(JSON.stringify(member)).not.toContain('localhost'); expect(JSON.stringify(member)).not.toContain('ownerId')
    await updateProviderConnection(database, 'owner', { id: saved.id, enabled: false }, path)
    expect((await getSetupSummary(database, 'member', configuration)).defaultModel.state).toBe('disabled')
  })

})
