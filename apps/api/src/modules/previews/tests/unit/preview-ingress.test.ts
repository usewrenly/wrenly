import { describe, expect, test } from 'bun:test'
import { createPreviewIngressHandler, type PreviewIngressConfiguration } from '../../gateway/preview-ingress'

const CAPABILITY = 'a'.repeat(64)
const PREVIEW = 'https://preview-one.localhost'
function configuration(overrides: Partial<PreviewIngressConfiguration> = {}): PreviewIngressConfiguration {
  return { upstream: 'http://172.30.0.2:3000', previewOrigin: PREVIEW,
    controlOrigin: 'http://localhost:3002', capability: CAPABILITY,
    blockedCookieNames: ['control-session', 'preview-grant'], ...overrides }
}
function request(path = '/', init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('x-wrenly-preview-ingress', CAPABILITY)
  return new Request(`${PREVIEW}${path}`, { ...init, headers })
}

describe('fixed preview ingress', () => {
  test('rejects unsafe configuration', () => {
    for (const upstream of ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://172.30.0.2:3000', 'http://172.30.0.2:3000/path']) {
      expect(() => createPreviewIngressHandler(configuration({ upstream }))).toThrow()
    }
    expect(() => createPreviewIngressHandler(configuration({ previewOrigin: 'http://localhost:4000' }))).toThrow()
    expect(() => createPreviewIngressHandler(configuration({ capability: 'short' }))).toThrow()
  })

  test('authenticates and validates host/protocol before fetching', async () => {
    let calls = 0
    const handler = createPreviewIngressHandler(configuration({ fetch: async () => { calls++; return new Response() } }))
    const denied = await handler(new Request(PREVIEW))
    expect(denied.status).toBe(401)
    expect(denied.headers.has('x-wrenly-preview-upstream')).toBe(false)
    expect((await handler(request('/', { headers: { host: 'attacker.localhost' } }))).status).toBe(403)
    expect((await handler(request('/', { headers: { upgrade: 'websocket' } }))).status).toBe(400)
    expect(calls).toBe(0)
  })

  test('pins destination and strips control credentials while preserving app request', async () => {
    const handler = createPreviewIngressHandler(configuration({ fetch: async forwarded => {
      expect(forwarded.url).toBe('http://172.30.0.2:3000//attacker.example/action?q=1')
      expect(forwarded.redirect).toBe('manual')
      expect(forwarded.method).toBe('POST')
      expect(await forwarded.text()).toBe('payload')
      expect(forwarded.headers.get('host')).toBe('preview-one.localhost')
      expect(forwarded.headers.get('x-forwarded-host')).toBe('preview-one.localhost')
      expect(forwarded.headers.get('x-forwarded-proto')).toBe('https')
      expect(forwarded.headers.get('origin')).toBe(PREVIEW)
      expect(forwarded.headers.get('next-action')).toBe('action-id')
      expect(forwarded.headers.get('cookie')).toBe('app-session=ok')
      for (const header of ['authorization', 'forwarded', 'x-real-ip', 'x-wrenly-preview-ingress', 'connection', 'x-remove']) {
        expect(forwarded.headers.has(header)).toBe(false)
      }
      return new Response('ok')
    } }))
    const response = await handler(request('//attacker.example/action?q=1', { method: 'POST', body: 'payload',
      headers: { authorization: 'Bearer secret', cookie: 'control-session=secret; app-session=ok; preview-grant=secret',
        origin: PREVIEW, 'next-action': 'action-id', forwarded: 'host=attacker', 'x-real-ip': 'secret',
        'x-forwarded-host': 'attacker', connection: 'x-remove', 'x-remove': 'secret' } }))
    expect(response.headers.get('x-wrenly-preview-upstream')).toBe('1')
    expect(await response.text()).toBe('ok')
  })

  test('rejects declared and streamed excessive request bodies', async () => {
    let calls = 0
    const handler = createPreviewIngressHandler(configuration({ requestLimitBytes: 3,
      fetch: async () => { calls++; return new Response() } }))
    expect((await handler(request('/', { method: 'POST', body: '1234', headers: { 'content-length': '4' } }))).status).toBe(413)
    expect((await handler(request('/', { method: 'POST', body: new ReadableStream({ start(output) {
      output.enqueue(new TextEncoder().encode('1234')); output.close()
    } }) }))).status).toBe(413)
    expect(calls).toBe(0)
  })

  test('filters cookies and rewrites internal redirects without following them', async () => {
    const headers = new Headers({ location: 'http://172.30.0.2:3000/login?next=home' })
    headers.append('set-cookie', 'app=ok; HttpOnly; Path=/')
    headers.append('set-cookie', 'control-session=bad; Path=/')
    headers.append('set-cookie', 'wide=bad; Domain=localhost')
    const handler = createPreviewIngressHandler(configuration({ fetch: async () => new Response(null, { status: 302, headers }) }))
    const response = await handler(request())
    expect(response.headers.get('location')).toBe(`${PREVIEW}/login?next=home`)
    expect(response.headers.getSetCookie()).toEqual(['app=ok; HttpOnly; Path=/'])
  })

  test('returns safe upstream errors', async () => {
    const handler = createPreviewIngressHandler(configuration({ fetch: async () => { throw new Error('private secret') } }))
    const response = await handler(request())
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private secret')
  })

  test('bounds response bytes and aborts upstream on overflow', async () => {
    let signal: AbortSignal | undefined
    const handler = createPreviewIngressHandler(configuration({ responseLimitBytes: 3, fetch: async forwarded => {
      signal = forwarded.signal
      return new Response('1234')
    } }))
    const response = await handler(request())
    await expect(response.text()).rejects.toThrow('Preview response interrupted.')
    expect(signal?.aborted).toBe(true)
  })

  test('cancelling response aborts upstream', async () => {
    let signal: AbortSignal | undefined
    let cancelled = false
    const handler = createPreviewIngressHandler(configuration({ fetch: async forwarded => {
      signal = forwarded.signal
      return new Response(new ReadableStream({ cancel() { cancelled = true } }))
    } }))
    const response = await handler(request())
    await response.body?.cancel()
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  test('deadline terminates a stalled response body after headers', async () => {
    let cancelled = false
    const handler = createPreviewIngressHandler(configuration({ timeoutMs: 10, fetch: async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true } })) }))
    const response = await handler(request())
    await expect(response.text()).rejects.toThrow('Preview response interrupted.')
    expect(cancelled).toBe(true)
  })

  test('deadline aborts a stalled upstream', async () => {
    const handler = createPreviewIngressHandler(configuration({ timeoutMs: 10, fetch: async forwarded =>
      new Promise<Response>((_resolve, reject) => {
        forwarded.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }) }))
    expect((await handler(request())).status).toBe(504)
  })
})
