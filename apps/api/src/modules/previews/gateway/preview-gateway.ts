// Serves previews on a separate origin after current viewer authorization.
// One-use bootstrap grants become host-only cookies; app forwarding uses trusted runtime state.
import { randomBytes } from 'crypto'
import { MediaOrigins } from '../media/preview-media-contract'

export const PREVIEW_COOKIE = '__Host-wrenly-preview'
const MAX_BOOTSTRAP_BYTES = 1024
const BOOTSTRAP_TIMEOUT_MS = 5000
const FORWARD_TIMEOUT_MS = 120_000
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60
export interface PreviewGatewayDependencies {
  baseUrl: string
  controlOrigin: string
  consume: (id: string, grant: string) => Promise<string | null>
  authorize: (id: string, session: string) => Promise<string | null>
  touch: (id: string, userId: string) => Promise<boolean>
  runtime: (id: string) => { ingressUrl: string; capability: string } | null
  mediaOrigins?: (id: string, userId: string) => Promise<string[]>
  fetch?: typeof fetch
}
function protectedHeaders(controlOrigin: string, origins: string[] = []): Headers {
  return new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': `frame-ancestors ${controlOrigin}; base-uri 'none'; object-src 'none'; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${origins.join(' ')}; media-src 'self' data: blob: ${origins.join(' ')}; connect-src 'self'; frame-src 'none'; form-action 'self'`,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'x-content-type-options': 'nosniff' })
}
/** A separate listener; caller validates configuration and never mounts this under the control /api origin. */
export function createPreviewGateway(dependencies: PreviewGatewayDependencies): (request: Request) => Promise<Response> {
  const base = new URL(dependencies.baseUrl)
  const control = new URL(dependencies.controlOrigin).origin
  return async request => {
    try {
      const url = new URL(request.url)
      const host = (request.headers.get('host') ?? url.host).toLowerCase()
      const suffix = '.' + base.host.toLowerCase()
      const id = host.endsWith(suffix) ? host.slice(0, -suffix.length) : ''
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) return new Response('Unknown preview host.', { status: 404 })
      const publicOrigin = `${base.protocol}//${host}`
      const headers = protectedHeaders(control)
      if (url.pathname === '/__wrenly/bootstrap' && request.method === 'GET') {
        const nonce = randomBytes(16).toString('hex')
        headers.set('content-type', 'text/html; charset=utf-8')
        headers.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors ${control}; base-uri 'none'; form-action 'none'`)
        return new Response(`<!doctype html><meta charset="utf-8"><title>Opening preview</title><p id="status">Opening preview…</p><script nonce="${nonce}">(async()=>{const grant=location.hash.slice(1);history.replaceState(null,'','/__wrenly/bootstrap');if(!grant){location.replace('/');return}try{const response=await fetch('/__wrenly/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant}),credentials:'same-origin'});if(!response.ok)throw Error();location.replace('/')}catch{document.getElementById('status').textContent='Preview access expired. Return to Wrenly and open a new preview link.'}})()</script>`, { headers })
      }
      if (url.pathname === '/__wrenly/access') {
        if (request.method !== 'POST' || request.headers.get('origin') !== publicOrigin) return new Response('Invalid preview access request.', { status: 403, headers })
        if (Number(request.headers.get('content-length') ?? 0) > MAX_BOOTSTRAP_BYTES) return new Response('Request too large.', { status: 413, headers })
        const reader = request.body?.getReader()
        let bytes = 0; const chunks: Uint8Array[] = []
        if (reader) {
          let timedOut = false
          const bodyTimer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, BOOTSTRAP_TIMEOUT_MS)
          try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > MAX_BOOTSTRAP_BYTES) { await reader.cancel(); return new Response('Request too large.', { status: 413, headers }) }; chunks.push(part.value) } }
          finally { clearTimeout(bodyTimer); reader.releaseLock() }
          if (timedOut) return new Response('Preview access request timed out.', { status: 408, headers })
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const token = typeof body === 'object' && body !== null && 'grant' in body && typeof body.grant === 'string' ? await dependencies.consume(id, body.grant) : null
        if (!token) return new Response('Preview access expired or already used.', { status: 401, headers })
        headers.append('set-cookie', `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`)
        return new Response(null, { status: 204, headers })
      }
      if (url.pathname.startsWith('/__wrenly/')) return new Response('Not found.', { status: 404, headers })
      const cookie = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(PREVIEW_COOKIE + '='))?.slice(PREVIEW_COOKIE.length + 1) ?? ''
      const userId = await dependencies.authorize(id, cookie)
      if (!userId) return new Response('Preview access is unavailable here. Use “Open in new tab” in Wrenly to authorize a new viewer.', { status: 401, headers })
      const runtime = dependencies.runtime(id)
      if (!runtime || !await dependencies.touch(id, userId)) return new Response('Preview expired. Restart it from Wrenly.', { status: 410, headers })
      const origins = MediaOrigins.parse(await dependencies.mediaOrigins?.(id, userId) ?? [])
      headers.set('content-security-policy', protectedHeaders(control, origins).get('content-security-policy')!)
      if (request.headers.has('upgrade') || request.method === 'CONNECT') return new Response('Protocol unsupported.', { status: 400, headers })
      const forwarded = new Headers(request.headers)
      for (const name of [...forwarded.keys()]) if (name.startsWith('x-wrenly-') || name === 'authorization' || name === 'forwarded') forwarded.delete(name)
      const appCookies = (forwarded.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value && !value.startsWith(PREVIEW_COOKIE + '='))
      if (appCookies.length) forwarded.set('cookie', appCookies.join('; ')); else forwarded.delete('cookie')
      forwarded.set('host', host); forwarded.set('x-wrenly-preview-ingress', runtime.capability)
      const abort = new AbortController()
      const onAbort = (): void => abort.abort()
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) abort.abort()
      const dispose = (): void => request.signal.removeEventListener('abort', onAbort)
      let upstream: Response
      try { upstream = await (dependencies.fetch ?? fetch)(runtime.ingressUrl + url.pathname + url.search, { method: request.method, headers: forwarded,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(FORWARD_TIMEOUT_MS)]) }) }
      catch { dispose(); return new Response('Preview runtime unavailable.', { status: 502, headers }) }
      const responseHeaders = new Headers(upstream.headers)
      for (const [name, value] of headers) responseHeaders.set(name, value)
      responseHeaders.delete('x-frame-options'); responseHeaders.delete('x-wrenly-preview-upstream'); responseHeaders.delete('content-length'); responseHeaders.delete('content-encoding')
      if (!upstream.body) { dispose(); return new Response(null, { status: upstream.status, headers: responseHeaders }) }
      const reader = upstream.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        async pull(output): Promise<void> {
          try { const part = await reader.read(); if (part.done) { dispose(); reader.releaseLock(); output.close() } else output.enqueue(part.value) }
          catch { abort.abort(); dispose(); output.error(new Error('Preview stream interrupted.')) }
        },
        async cancel(): Promise<void> { abort.abort(); dispose(); try { await reader.cancel() } finally { reader.releaseLock() } },
      })
      return new Response(stream, { status: upstream.status, headers: responseHeaders })
    } catch { return new Response('Preview request failed.', { status: 400, headers: protectedHeaders(control) }) }
  }
}
