// Real HTTP boundary with local controlled servers; no Gitea/Coolify or model calls.
import { describe, expect, test } from 'bun:test'
import { createDeploymentProviderClient } from '../../../src/http/provider-client'
const integration = process.env.WRENLY_TEST_DEPLOY_HTTP === 'true' ? describe : describe.skip
integration('deployment provider HTTP boundary', () => {
  test('native fetch refuses redirects without forwarding credentials and bounds slow bodies', async () => {
    let foreignRequests = 0; let cancelled = false; let tokenSeen = false
    const foreign = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { foreignRequests++; return Response.json({}) } })
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
      tokenSeen = request.headers.get('authorization') === 'Bearer trusted-fixture'
      const path = new URL(request.url).pathname
      if (path.endsWith('/redirect')) return Response.redirect(`http://127.0.0.1:${foreign.port}/target`, 302)
      if (path.endsWith('/slow')) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { cancelled = true },
      }))
      return Response.json({ private: true })
    } })
    try {
      const client = createDeploymentProviderClient({ origin: `http://127.0.0.1:${provider.port}`, token: 'trusted-fixture', authentication: 'Bearer', timeoutMs: 200 })
      expect(await client.request('GET', '/api/v1/repository')).toEqual({ private: true })
      await expect(client.request('POST', '/api/v1/redirect', {})).rejects.toThrow('request_failed')
      expect(foreignRequests).toBe(0); expect(tokenSeen).toBe(true)
      await expect(client.request('GET', '/api/v1/slow')).rejects.toThrow('timeout')
      const deadline = Date.now() + 1000
      while (!cancelled && Date.now() < deadline) await Bun.sleep(10)
      expect(cancelled).toBe(true)
    } finally { await provider.stop(true); await foreign.stop(true) }
  }, 5000)
})
