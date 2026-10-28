import { expect, test } from 'bun:test'
import { createDeploymentProviderClient, DeploymentProviderError } from '../../../src/http/provider-client'
const configuration = { origin: 'https://gitea.example', token: 'private-provider-token', authentication: 'token' as const }
function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handler(new URL(input instanceof Request ? input.url : String(input)), init ?? {}), { preconnect: fetch.preconnect })
}

test('pins destination and authentication and disables redirects/credential inheritance', async () => {
  const client = createDeploymentProviderClient(configuration, transport((url, init) => {
    expect(url.href).toBe('https://gitea.example/api/v1/repos/owner/repo')
    expect(new Headers(init.headers).get('authorization')).toBe('token private-provider-token')
    expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit')
    expect(init.method).toBe('POST'); expect(init.body).toBe('{"private":true}')
    return Response.json({ id: 1 })
  }))
  expect(await client.request('POST', '/api/v1/repos/owner/repo', { private: true })).toEqual({ id: 1 })
})

test('invalid origins, tokens and escaping endpoints fail before transport', async () => {
  let calls = 0
  const fake = transport(() => { calls++; return Response.json({}) })
  for (const origin of ['https://token@host', 'https://host/path', 'file:///tmp/file', 'https://host?secret=1'])
    expect(() => createDeploymentProviderClient({ ...configuration, origin }, fake)).toThrow('invalid_configuration')
  const client = createDeploymentProviderClient(configuration, fake)
  for (const endpoint of ['https://foreign/api/v1/repos', '//foreign/api/v1/repos', '/api/v1/../admin', '/api/v1/%2e%2e/admin', '/api/v1/a%2fb', '/api/v1/repos#fragment'])
    await expect(client.request('GET', endpoint)).rejects.toThrow('invalid_endpoint')
  await expect(client.request('POST', '/api/v1/repos', { large: 'x'.repeat(128 * 1024) })).rejects.toThrow('request_too_large')
  expect(calls).toBe(0)
})

test('provider errors and redirects expose status only and never replay a mutation', async () => {
  for (const status of [302, 401, 404, 409, 500]) {
    let calls = 0
    const client = createDeploymentProviderClient(configuration, transport(() => {
      calls++; return new Response('private-provider-token private response body', { status })
    }))
    try { await client.request('POST', '/api/v1/repos'); throw Error('Expected failure') } catch (error) {
      expect(error).toBeInstanceOf(DeploymentProviderError)
      expect((error as DeploymentProviderError).status).toBe(status)
      expect(String(error)).not.toContain('private')
    }
    expect(calls).toBe(1)
  }
})

test('bounds declared and streamed response size and rejects invalid JSON without leaking it', async () => {
  for (const response of [new Response('private-invalid-json'), new Response('{}', { headers: { 'content-length': '300000' } }),
    new Response('x'.repeat(300000))]) {
    const client = createDeploymentProviderClient(configuration, transport(() => response))
    await expect(client.request('GET', '/api/v1/repos')).rejects.toBeInstanceOf(DeploymentProviderError)
    expect(response.body?.locked).toBe(false)
  }
})

test('deadline includes a hanging response body and cancels its reader', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { cancelled = true } }))
  const client = createDeploymentProviderClient({ ...configuration, timeoutMs: 20 }, transport(() => response))
  await expect(client.request('GET', '/api/v1/repos')).rejects.toThrow('timeout')
  expect(cancelled).toBe(true)
})

test('external cancellation stops a hanging transport and late responses are discarded', async () => {
  let cancelled = false
  const client = createDeploymentProviderClient(configuration, transport(async () => {
    await Bun.sleep(40)
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  }))
  const controller = new AbortController()
  const pending = client.request('POST', '/api/v1/repos', {}, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  await Bun.sleep(60)
  expect(cancelled).toBe(true)
})
