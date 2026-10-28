import { laravelFixture } from '../../../../sandbox/tests/laravel-fixture'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, inArray } from 'drizzle-orm'
import * as schema from '../../../src/schema'
import {
  admitDeployment, claimNextDeployment, renewDeploymentLease, beginDeploymentMutation,
  completeDeploymentMutation, markDeploymentVerifying, interruptExpiredDeployments, getOwnedDeployment,
  prepareDeploymentRuntimeEnvironment,
  prepareDeploymentSshKey, cancelQueuedDeployment,
} from '../../../../../apps/api/src/modules/deployments/persistence/deployment-store'

import { loadInterruptedDeployment, finishInterruptedReconciliation } from '../../../../../apps/api/src/modules/deployments/persistence/reconciliation-store'
import { executeDeployment } from '../../../../../apps/api/src/modules/deployments/execution/deployment-executor'
import { parseApiEnvironment } from '../../../../../apps/api/src/config/api-environment'
import { DeploymentProviderError, type DeploymentProviderClient } from '../../../../deploy/src/http/provider-client'

const testUrl = process.env.WRENLY_TEST_DATABASE_URL
if (testUrl) {
  const url = new URL(testUrl)
  if (url.pathname !== '/wrenly_deployment_test' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Deployment tests require a disposable local wrenly_deployment_test database.')
}
const integration = testUrl ? describe : describe.skip
integration('owned durable deployment admission and claims', () => {
  const client = postgres(testUrl ?? 'postgresql://localhost/wrenly_deployment_test', { onnotice: () => {} })
  const db = drizzle(client, { schema })
  const userId = `deployment-store-${crypto.randomUUID()}`
  const projectIds: string[] = []
  const target = { gitInstanceUrl: 'http://gitea.test', repositoryOwner: 'apps', coolifyInstanceUrl: 'http://coolify.test',
    coolifyProjectUuid: 'project', coolifyServerUuid: 'server', coolifyEnvironmentName: 'production' }
  const foreignOwner = `${userId}-foreign`
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` })
    await db.insert(schema.user).values({id:foreignOwner,name:'Foreign test account',email:`${foreignOwner}@example.test`})
    await db.insert(schema.user).values({ id: userId, name: 'Deployment test', email: `${userId}@example.test` })
  })
  afterEach(async () => {
    if (!projectIds.length) return
    await db.delete(schema.deployments).where(inArray(schema.deployments.projectId, projectIds))
    await db.delete(schema.deploymentResources).where(inArray(schema.deploymentResources.projectId, projectIds))
    await db.delete(schema.projects).where(inArray(schema.projects.id, projectIds))
    projectIds.length = 0
  })
  afterAll(async () => {
    await db.delete(schema.user).where(eq(schema.user.id,foreignOwner));
    try { await db.delete(schema.user).where(eq(schema.user.id, userId)) } finally { await client.end() } })
  async function fixture(): Promise<{ projectId: string; buildId: string; userId: string; idempotencyKey: string; target: typeof target }> {
    const projectId = crypto.randomUUID(); const buildId = crypto.randomUUID()
    projectIds.push(projectId)
    await db.insert(schema.projects).values({ id: projectId, userId, name: 'Fixture' })
    await db.insert(schema.builds).values({ id: buildId, projectId, prompt: 'Fixture', stack: 'nextjs', status: 'success', files: [{ path: 'app/page.tsx', content: 'original' }] })
    return { projectId, buildId, userId, idempotencyKey: crypto.randomUUID(), target }
  }
  test('queued cancellation races safely with claiming and cannot cancel running work', async () => {
    const input = await fixture(); const admitted = await admitDeployment(db, input)
    await expect(cancelQueuedDeployment(db, 'foreign', input.projectId, admitted.deploymentId)).rejects.toThrow('not found')
    await cancelQueuedDeployment(db, userId, input.projectId, admitted.deploymentId)
    await cancelQueuedDeployment(db, userId, input.projectId, admitted.deploymentId)
    expect(await claimNextDeployment(db)).toBeNull()
    expect((await getOwnedDeployment(db, userId, input.projectId, admitted.deploymentId))?.status).toBe('cancelled')
    const second = await admitDeployment(db, { ...input, idempotencyKey: crypto.randomUUID() })
    await claimNextDeployment(db)
    await expect(cancelQueuedDeployment(db, userId, input.projectId, second.deploymentId)).rejects.toThrow('already started')
  })
  test('operator reconciliation requires settled interrupted state and rejects changed evidence', async () => {
    const input = await fixture(); const admitted = await admitDeployment(db, input)
    await expect(loadInterruptedDeployment(db, admitted.deploymentId)).rejects.toThrow('interrupted')
    await db.update(schema.deployments).set({ status: 'interrupted', updatedAt: new Date(Date.now() - 70_000) }).where(eq(schema.deployments.id, admitted.deploymentId))
    const original = await loadInterruptedDeployment(db, admitted.deploymentId)
    await db.update(schema.deployments).set({ updatedAt: new Date(Date.now() - 66_000) }).where(eq(schema.deployments.id, admitted.deploymentId))
    await expect(finishInterruptedReconciliation(db, original, { repositoryId: null, applicationId: null, jobId: null })).rejects.toThrow('changed')
    const current = await loadInterruptedDeployment(db, admitted.deploymentId)
    await finishInterruptedReconciliation(db, current, { repositoryId: null, applicationId: null, jobId: null })
    expect((await getOwnedDeployment(db, userId, input.projectId, admitted.deploymentId))?.status).toBe('failed')
    expect((await admitDeployment(db, { ...input, idempotencyKey: crypto.randomUUID() })).replayed).toBe(false)
  })
  test('image executor persists artifact/job evidence and publishes only the confirmed runtime', async () => {
    const input = await fixture()
    const imageTarget = { ...target, registryOrigin: 'http://127.0.0.1:5000', registryNamespace: 'wrenly' }
    const admitted = await admitDeployment(db, { ...input, target: imageTarget })
    const claim = (await claimNextDeployment(db))!
    const calls: string[] = []
    let applicationImage = ''
    const git: DeploymentProviderClient = { request: async (method, endpoint) => {
      calls.push(`${method} ${endpoint}`)
      if (endpoint === '/api/v1/user') return { login: 'fixture' }
      if (method === 'GET') throw new DeploymentProviderError('http_error', 404)
      return { id: 1, private: true, owner: { login: 'apps' }, name: `wrenly-${input.projectId}` }
    } }
    const coolify: DeploymentProviderClient = { request: async (method, endpoint, body) => {
      calls.push(`${method} ${endpoint}`)
      if (endpoint === '/api/v1/applications/dockerimage') {
        applicationImage = (body as { docker_registry_image_name: string }).docker_registry_image_name
        return { uuid: 'app' }
      }
      if (endpoint === '/api/v1/applications/app') {
        const [repository, digest] = applicationImage.split('@sha256:')
        return { uuid: 'app', name: `wrenly-${input.projectId}`, build_pack: 'dockerimage',
          docker_registry_image_name: repository + '@sha256', docker_registry_image_tag: digest, fqdn: 'https://fixture.example' }
      }
      if (endpoint === '/api/v1/deploy?uuid=app') return { deployments: [{ resource_uuid: 'app', deployment_uuid: 'job' }] }
      if (endpoint === '/api/v1/deployments/job') return { deployment_uuid: 'job', status: 'finished' }
      throw new Error('Unexpected provider call')
    } }
    const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: testUrl!, WRENLY_AUTH_SECRET: 'fixture', WRENLY_APP_URL: 'http://localhost:3002',
      WRENLY_GIT_BASE_URL: target.gitInstanceUrl, WRENLY_GIT_ORG: 'apps', WRENLY_GIT_TOKEN: 'fixture-token',
      WRENLY_COOLIFY_API_URL: target.coolifyInstanceUrl, WRENLY_COOLIFY_API_KEY: 'fixture-key',
      WRENLY_COOLIFY_PROJECT_UUID: 'project', WRENLY_COOLIFY_SERVER_UUID: 'server', WRENLY_REGISTRY_URL: imageTarget.registryOrigin,
      WRENLY_REGISTRY_USERNAME: 'fixture', WRENLY_REGISTRY_PASSWORD: 'fixture-password', WRENLY_DEPLOY_ENCRYPTION_KEY: 'ab'.repeat(32) })
    await executeDeployment(db, claim, environment, new AbortController().signal, {
      pushSource: async () => 'a'.repeat(40),
      build: async input => { await input.beforeEffect(); return { imageId: `sha256:${'b'.repeat(64)}`, baseImageId: `sha256:${'c'.repeat(64)}`, sizeBytes: 1024 } },
      publish: async input => { await input.beforeEffect(); return { repository: `127.0.0.1:5000/wrenly/deployment-${admitted.deploymentId}`, digest: `sha256:${'d'.repeat(64)}` } },
      ready: async (url, deploymentId) => { expect([url, deploymentId]).toEqual(['https://fixture.example/', admitted.deploymentId]); return true },
    }, { git, coolify })
    expect(await getOwnedDeployment(db, userId, input.projectId, admitted.deploymentId)).toMatchObject({ status: 'success', url: 'https://fixture.example/' })
    const [saved] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, admitted.deploymentId))
    expect(saved?.remoteDeploymentUuid).toBe('job'); expect(saved?.registryDigest).toBe(`sha256:${'d'.repeat(64)}`)
    expect(saved?.mutationIntent).toBeNull()
    expect(calls.filter(call => call === 'POST /api/v1/deploy?uuid=app')).toHaveLength(1)
    expect(calls.join(' ')).not.toContain('private-deploy-key')
  })
  test('lost provider acknowledgement preserves intent and blocks another publishing request', async () => {
    const input = await fixture()
    const imageTarget = { ...target, registryOrigin: 'http://127.0.0.1:5000', registryNamespace: 'wrenly' }
    const admitted = await admitDeployment(db, { ...input, target: imageTarget })
    const claim = (await claimNextDeployment(db))!
    let creates = 0
    const git: DeploymentProviderClient = { request: async (method, endpoint) => {
      if (endpoint === '/api/v1/user') return { login: 'fixture' }
      if (method === 'GET') throw new DeploymentProviderError('http_error', 404)
      creates++; throw new Error('Lost response after remote creation')
    } }
    const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: testUrl!, WRENLY_AUTH_SECRET: 'fixture', WRENLY_APP_URL: 'http://localhost:3002',
      WRENLY_GIT_BASE_URL: target.gitInstanceUrl, WRENLY_GIT_ORG: 'apps', WRENLY_GIT_TOKEN: 'fixture-token',
      WRENLY_COOLIFY_API_URL: target.coolifyInstanceUrl, WRENLY_COOLIFY_API_KEY: 'fixture-key', WRENLY_COOLIFY_PROJECT_UUID: 'project',
      WRENLY_COOLIFY_SERVER_UUID: 'server', WRENLY_REGISTRY_URL: imageTarget.registryOrigin })
    await executeDeployment(db, claim, environment, new AbortController().signal, undefined, { git, coolify: { request: async () => { throw new Error('Must not deploy') } } })
    expect(creates).toBe(1)
    const [saved] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, admitted.deploymentId))
    expect(saved?.status).toBe('interrupted'); expect(saved?.mutationIntent?.kind).toBe('create_repository')
    await expect(admitDeployment(db, { ...input, target: imageTarget, idempotencyKey: crypto.randomUUID() })).rejects.toThrow('interrupted')
  })
  test('concurrent retries create one frozen operation and reject conflicting key reuse', async () => {
    const input = await fixture()
    const results = await Promise.all([admitDeployment(db, input), admitDeployment(db, input)])
    expect(results[0]?.deploymentId).toBe(results[1]?.deploymentId)
    expect(results.filter(row => row.replayed)).toHaveLength(1)
    await db.update(schema.builds).set({ files: [{ path: 'app/page.tsx', content: 'changed' }] }).where(eq(schema.builds.id, input.buildId))
    const [saved] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, results[0]!.deploymentId))
    expect(saved?.files[0]?.content).toBe('original')
    await expect(admitDeployment(db, { ...input, buildId: crypto.randomUUID() })).rejects.toThrow('idempotency key')
    await expect(admitDeployment(db, { ...input, idempotencyKey: crypto.randomUUID() })).rejects.toThrow('active or interrupted')
  })
  test('ownership and explicit successful revision are mandatory with no resource admission on rejection', async () => {
    const input = await fixture(); const foreign = await fixture()
    await expect(admitDeployment(db, { ...input, userId: foreignOwner })).rejects.toThrow('Project not found')
    await expect(admitDeployment(db, { ...input, buildId: foreign.buildId })).rejects.toThrow('Build not found')
    await expect(admitDeployment(db, { ...input, buildId: 'bad' })).rejects.toThrow('UUIDs')
    await db.update(schema.builds).set({ status: 'failed' }).where(eq(schema.builds.id, input.buildId))
    await expect(admitDeployment(db, input)).rejects.toThrow('successful build')
    expect(await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, input.projectId))).toHaveLength(0)
  })
  test('unsafe source and credential-bearing server targets never enter the queue', async () => {
    const input = await fixture()
    await expect(admitDeployment(db, { ...input, target: { ...target, gitInstanceUrl: 'http://token@gitea.test' } })).rejects.toThrow('embedded credentials')
    await db.update(schema.builds).set({ files: [{ path: '.env', content: 'secret' }] }).where(eq(schema.builds.id, input.buildId))
    await expect(admitDeployment(db, input)).rejects.toThrow('private deployment source')
    expect(await db.select().from(schema.deployments).where(eq(schema.deployments.projectId, input.projectId))).toHaveLength(0)
  })
  test('saved targets cannot be silently redirected while replay survives config changes', async () => {
    const input = await fixture(); const first = await admitDeployment(db, input)
    expect((await admitDeployment(db, { ...input, target: { ...target, coolifyServerUuid: 'changed' } })).deploymentId).toBe(first.deploymentId)
    await db.update(schema.deployments).set({ status: 'failed' }).where(eq(schema.deployments.id, first.deploymentId))
    await expect(admitDeployment(db, { ...input, idempotencyKey: crypto.randomUUID(), target: { ...target, coolifyServerUuid: 'changed' } })).rejects.toThrow('saved target')
  })
  test('claims serialize globally and remote results match one persisted mutation intent', async () => {
    const first = await fixture(); const second = await fixture()
    await admitDeployment(db, first); await admitDeployment(db, second)
    const claims = await Promise.all([claimNextDeployment(db), claimNextDeployment(db)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claim = claims.find(row => row !== null)!
    await expect(renewDeploymentLease(db, { ...claim, token: crypto.randomUUID() })).rejects.toThrow('valid lease')
    await renewDeploymentLease(db, claim)
    const intent = await beginDeploymentMutation(db, claim, 'create_repository')
    await expect(beginDeploymentMutation(db, claim, 'push_source')).rejects.toThrow('unresolved')
    await expect(completeDeploymentMutation(db, claim, { kind: intent.kind, operationId: crypto.randomUUID(), id: 'repo-1' })).rejects.toThrow('does not match')
    await completeDeploymentMutation(db, claim, { ...intent, id: 'repo-1' })
    const [saved] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, claim.deploymentId))
    const [resources] = await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, saved!.projectId))
    expect(saved?.mutationIntent).toBeNull(); expect(resources?.repositoryId).toBe('repo-1')
  })
  test('expired work preserves remote intent and stale claims cannot renew or acknowledge it', async () => {
    const input = await fixture(); const admitted = await admitDeployment(db, input)
    const claim = (await claimNextDeployment(db))!
    const intent = await beginDeploymentMutation(db, claim, 'trigger_deploy')
    await db.update(schema.deployments).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.deployments.id, admitted.deploymentId))
    await expect(renewDeploymentLease(db, claim)).rejects.toThrow('valid lease')
    expect(await interruptExpiredDeployments(db)).toBe(1)
    expect(await claimNextDeployment(db)).toBeNull()
    await expect(completeDeploymentMutation(db, claim, { ...intent, id: 'remote-job' })).rejects.toThrow('valid lease')
    await expect(admitDeployment(db, { ...input, idempotencyKey: crypto.randomUUID() })).rejects.toThrow('interrupted')
    const [saved] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, admitted.deploymentId))
    expect(saved?.mutationIntent).toEqual(intent); expect(saved?.status).toBe('interrupted')
  })
  test('provider completion moves into routed verification only under the live claim', async () => {
    const input = await fixture();
    const admitted = await admitDeployment(db, input);
    const claim = (await claimNextDeployment(db))!;
    await expect(markDeploymentVerifying(db, claim)).rejects.toThrow('completed remote deployment');
    const intent = await beginDeploymentMutation(db, claim, 'trigger_deploy');
    await completeDeploymentMutation(db, claim, { ...intent, id: 'verified-remote-job' });
    await markDeploymentVerifying(db, claim);
    expect((await getOwnedDeployment(db, userId, input.projectId, admitted.deploymentId))?.status).toBe('verifying');
    await expect(markDeploymentVerifying(db, { ...claim, token: crypto.randomUUID() })).rejects.toThrow();
    expect((await getOwnedDeployment(db, userId, input.projectId, admitted.deploymentId))?.status).toBe('verifying');
  })
  test('owner status excludes source, claims, operation identities and remote secrets', async () => {
    const input = await fixture(); const saved = await admitDeployment(db, input)
    expect(await getOwnedDeployment(db, 'foreign', input.projectId, saved.deploymentId)).toBeNull()
    expect(await getOwnedDeployment(db, userId, crypto.randomUUID(), saved.deploymentId)).toBeNull()
    const status = await getOwnedDeployment(db, userId, input.projectId, saved.deploymentId)
    expect(Object.keys(status ?? {}).sort()).toEqual(['buildId', 'errorCode', 'id', 'status', 'url'])
  })
  test('bounded admission rejects new work without losing replay of accepted requests', async () => {
    let accepted: Awaited<ReturnType<typeof fixture>> | undefined
    for (let index = 0; index < 20; index++) {
      const input = await fixture()
      await admitDeployment(db, input)
      accepted ??= input
    }
    const overflow = await fixture()
    await expect(admitDeployment(db, overflow)).rejects.toThrow('queue is full')
    expect((await admitDeployment(db, accepted!)).replayed).toBe(true)
    expect(await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, overflow.projectId))).toHaveLength(0)
  })
  test('Laravel runtime keys are encrypted, stable and never replaced after authentication failure', async () => {
    const input = await fixture()
    await db.update(schema.projects).set({ stack: 'laravel' }).where(eq(schema.projects.id, input.projectId))
    await db.update(schema.builds).set({ stack: 'laravel', files: laravelFixture() }).where(eq(schema.builds.id, input.buildId))
    await admitDeployment(db, input)
    const claim = (await claimNextDeployment(db))!
    const key = 'ab'.repeat(32)
    const first = await prepareDeploymentRuntimeEnvironment(db, claim, key)
    const second = await prepareDeploymentRuntimeEnvironment(db, claim, key)
    expect(first.APP_KEY).toBe(second.APP_KEY)
    expect(first.APP_DEBUG).toBe('false')
    expect(first.CACHE_STORE).toBe('array')
    expect(first.LOG_CHANNEL).toBe('stderr')
    const [saved] = await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, input.projectId))
    expect(JSON.stringify(saved)).not.toContain(first.APP_KEY!)
    await expect(prepareDeploymentRuntimeEnvironment(db, claim, 'cd'.repeat(32))).rejects.toThrow('could not be authenticated')
    const [unchanged] = await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, input.projectId))
    expect(unchanged?.encryptedLaravelAppKey).toEqual(saved?.encryptedLaravelAppKey)
    await expect(prepareDeploymentRuntimeEnvironment(db, { ...claim, token: crypto.randomUUID() }, key)).rejects.toThrow('valid lease')
  })
  test('project SSH identities persist encrypted and survive repeated preparation', async () => {
    const input = await fixture(); await admitDeployment(db, input)
    const claim = (await claimNextDeployment(db))!
    const key = 'ab'.repeat(32)
    const first = await prepareDeploymentSshKey(db, claim, key)
    const second = await prepareDeploymentSshKey(db, claim, key)
    expect(first.privateKey).toBe(second.privateKey)
    expect(first.publicKey.split(' ').slice(0, 2)).toEqual(second.publicKey.split(' ').slice(0, 2))
    const [saved] = await db.select().from(schema.deploymentResources).where(eq(schema.deploymentResources.projectId, input.projectId))
    expect(JSON.stringify(saved)).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    await expect(prepareDeploymentSshKey(db, claim, 'cd'.repeat(32))).rejects.toThrow('could not be authenticated')
    await db.update(schema.deploymentResources).set({ encryptedDeployPrivateKey: null, gitDeployKeyId: 'registered-key' }).where(eq(schema.deploymentResources.projectId, input.projectId))
    await expect(prepareDeploymentSshKey(db, claim, key)).rejects.toThrow('missing')
  })
})
