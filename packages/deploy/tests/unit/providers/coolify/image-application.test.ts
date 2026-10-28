import { expect, test } from 'bun:test'
import { createImageApplication, readImageApplication, updateImageApplication, triggerImageDeployment, readImageDeployment } from '../../../../src/providers/coolify/image-application'
import { verifyDeploymentReadiness } from '../../../../src/providers/coolify/readiness'
import type { DeploymentProviderClient } from '../../../../src/http/provider-client'
const image = `registry.example/apps/project@sha256:${'a'.repeat(64)}`
const signal = new AbortController().signal

test('image application uses digest with no source rebuild or implicit trigger', async () => {
  const calls: string[] = []
  const provider: DeploymentProviderClient = { request: async (method, endpoint, body) => {
    calls.push(`${method} ${endpoint}`)
    expect(body).toMatchObject({ docker_registry_image_name: method === 'POST' ? image : 'registry.example/apps/project@sha256',
      docker_registry_image_tag: method === 'POST' ? null : 'a'.repeat(64),
      instant_deploy: false, limits_cpus: '2', limits_memory: '2048m', is_auto_deploy_enabled: false,
      health_check_host: '127.0.0.1', health_check_port: '3000' })
    expect(body).not.toHaveProperty('git_repository')
    return { uuid: 'application' }
  } }
  expect(await createImageApplication(provider, { name: 'wrenly-project', projectUuid: 'project', serverUuid: 'server', environmentName: 'production', image }, signal)).toBe('application')
  await updateImageApplication(provider, 'application', image, signal)
  expect(calls).toEqual(['POST /api/v1/applications/dockerimage', 'PATCH /api/v1/applications/application'])
  await expect(updateImageApplication(provider, 'application', 'registry.example/apps/project:latest', signal)).rejects.toThrow('invalid_input')
})

test('application and job reads verify exact saved identity and reject source apps', async () => {
  const provider: DeploymentProviderClient = { request: async () => ({ uuid: 'app', name: 'wrenly-project', build_pack: 'dockerimage',
    docker_registry_image_name: 'registry.example/apps/project@sha256', docker_registry_image_tag: 'a'.repeat(64), fqdn: 'https://app.example', status: 'running:healthy', private: 'secret' }) }
  expect(await readImageApplication(provider, 'app', 'wrenly-project', signal)).toEqual({ uuid: 'app', image, url: 'https://app.example/', status: 'running:healthy' })
  await expect(readImageApplication(provider, 'other', 'wrenly-project', signal)).rejects.toThrow('invalid_response')
  await expect(readImageApplication({ request: async () => ({ uuid: 'app', name: 'wrenly-project', build_pack: 'nixpacks' }) }, 'app', 'wrenly-project', signal)).rejects.toThrow('invalid_response')
  expect(await triggerImageDeployment({ request: async () => ({ deployments: [{ resource_uuid: 'app', deployment_uuid: 'job' }] }) }, 'app', signal)).toBe('job')
  await expect(triggerImageDeployment({ request: async () => ({ deployments: [{ resource_uuid: 'other', deployment_uuid: 'job' }] }) }, 'app', signal)).rejects.toThrow('invalid_response')
  expect(await readImageDeployment({ request: async () => ({ deployment_uuid: 'job', status: 'finished' }) }, 'job', signal)).toBe('success')
  await expect(readImageDeployment({ request: async () => ({ deployment_uuid: 'other', status: 'finished' }) }, 'job', signal)).rejects.toThrow('invalid_response')
})

test('readiness rejects stale revision, redirects and oversized markers without credentials', async () => {
  const id = crypto.randomUUID()
  const calls: string[] = []
  const transport: typeof fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input)); expect(options?.credentials).toBe('omit'); expect(options?.redirect).toBe('error')
    expect(options?.headers).not.toHaveProperty('Authorization')
    return new Response(calls.length % 2 ? 'App' : id)
  }, { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, signal, transport)).toBe(true)
  expect(calls).toEqual(['https://app.example/', 'https://app.example/.well-known/wrenly-deployment'])
  const stale = Object.assign(async () => new Response('previous'), { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, signal, stale)).toBe(false)
  const large = Object.assign(async () => new Response('x'.repeat(129)), { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, signal, large)).toBe(false)
  expect(await verifyDeploymentReadiness('https://user:secret@app.example/', id, signal, transport)).toBe(false)
})

test('readiness reports bounded reasons without remote bodies or exception text', async () => {
  const reasons: string[] = []
  const report = (reason: string): void => { reasons.push(reason) }
  const id = crypto.randomUUID()
  const offline = Object.assign(async () => { throw new Error('private diagnostic') }, { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, signal, offline, report)).toBe(false)
  const unavailable = Object.assign(async () => new Response('private remote body', { status: 503 }), { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, signal, unavailable, report)).toBe(false)
  const stale = Object.assign(async () => new Response('previous'), { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, signal, stale, report)).toBe(false)
  const cancelled = AbortSignal.abort()
  const aborted = Object.assign(async () => { cancelled.throwIfAborted(); return new Response() }, { preconnect: fetch.preconnect })
  expect(await verifyDeploymentReadiness('https://app.example/', id, cancelled, aborted, report)).toBe(false)
  expect(reasons).toEqual(['network_error', 'application_http_error', 'marker_mismatch', 'aborted'])
})

test('image updates preserve registry ports and exact sha256 identity in Coolify stored fields', async () => {
  const digest = 'b'.repeat(64)
  const client: DeploymentProviderClient = { request: async (method, endpoint, body) => {
    expect(method).toBe('PATCH')
    expect(endpoint).toBe('/api/v1/applications/application')
    expect(body).toMatchObject({ docker_registry_image_name: '127.0.0.1:5001/wrenly/project@sha256',
      docker_registry_image_tag: digest, instant_deploy: false })
    return { uuid: 'application' }
  } }
  await updateImageApplication(client, 'application', `127.0.0.1:5001/wrenly/project@sha256:${digest}`, signal)
})
