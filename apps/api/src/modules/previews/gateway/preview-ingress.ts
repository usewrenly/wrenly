// Trusted proxy for one verified preview app, never a caller-selected destination.
// Requires the private gateway capability, strips control credentials and hop headers,
// bounds body streaming and propagates cancellation/deadlines. It grants no browsing.
import { timingSafeEqual } from 'crypto'

const INGRESS_HEADER = 'x-wrenly-preview-ingress'
const DEFAULT_REQUEST_LIMIT_BYTES = 1024 * 1024
const DEFAULT_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']
const MAX_TIMEOUT_MS = 120_000

type UpstreamFetch = (request: Request) => Promise<Response>
export interface PreviewIngressConfiguration {
  upstream: string
  previewOrigin: string
  controlOrigin: string
  capability: string
  blockedCookieNames: string[]
  requestLimitBytes?: number
  responseLimitBytes?: number
  timeoutMs?: number
  fetch?: UpstreamFetch
}

class RequestBodyLimitError extends Error {}

function origin(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid preview origin configuration.')
  return url
}

function privateAddress(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

function stripHopHeaders(headers: Headers): void {
  for (const name of (headers.get('connection') ?? '').split(',')) {
    if (name.trim()) headers.delete(name.trim())
  }
  for (const name of HOP_HEADERS) headers.delete(name)
}

async function boundedBody(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { void reader.cancel().catch(() => {}); reject(new Error('Preview request aborted.')) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  void aborted.catch(() => {})
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      total += value.byteLength
      if (total > limit) throw new RequestBodyLimitError()
      chunks.push(value)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return body
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { signal.removeEventListener('abort', onAbort); reader.releaseLock() }
}

/** Creates an authenticated fixed-target proxy; caller must verify Docker ownership and network isolation. */
export function createPreviewIngressHandler(configuration: PreviewIngressConfiguration): UpstreamFetch {
  const target = origin(configuration.upstream)
  const preview = origin(configuration.previewOrigin)
  const control = origin(configuration.controlOrigin)
  if (target.protocol !== 'http:' || !privateAddress(target.hostname) || !target.port)
    throw new Error('Preview ingress requires an explicit private app address and port.')
  if (preview.hostname === control.hostname) throw new Error('Preview must use a different hostname from Wrenly.')
  if (!/^[a-f0-9]{64}$/i.test(configuration.capability)) throw new Error('Invalid preview ingress capability.')
  const secret = Buffer.from(configuration.capability)
  const blockedCookies = new Set(configuration.blockedCookieNames)
  const requestLimit = configuration.requestLimitBytes ?? DEFAULT_REQUEST_LIMIT_BYTES
  const responseLimit = configuration.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES
  const timeout = configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (![requestLimit, responseLimit, timeout].every(value => Number.isSafeInteger(value) && value > 0) || timeout > MAX_TIMEOUT_MS)
    throw new Error('Invalid preview ingress resource limits.')
  const fetchUpstream = configuration.fetch ?? ((request: Request) => fetch(request))

  return async (request): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get(INGRESS_HEADER) ?? '')
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret))
      return Response.json({ error: 'Unauthorized preview ingress.' }, { status: 401 })
    const incoming = new URL(request.url)
    if ((request.headers.get('host') ?? incoming.host).toLowerCase() !== preview.host.toLowerCase())
      return Response.json({ error: 'Invalid preview host.' }, { status: 403 })
    if (request.method === 'CONNECT' || request.headers.has('upgrade'))
      return Response.json({ error: 'Preview protocol is unsupported.' }, { status: 400 })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
    const abort = (): void => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const dispose = (): void => { clearTimeout(timer); request.signal.removeEventListener('abort', abort) }
    try {
      const declared = request.headers.get('content-length')
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > requestLimit)) throw new RequestBodyLimitError()
      const body = await boundedBody(request, requestLimit, controller.signal)
      const headers = new Headers(request.headers)
      stripHopHeaders(headers)
      for (const name of [...headers.keys()]) {
        if (name === 'authorization' || name === 'forwarded' || name === 'x-real-ip' ||
          name.startsWith('x-forwarded-') || name.startsWith('x-wrenly-')) headers.delete(name)
      }
      const cookies = (headers.get('cookie') ?? '').split(';').map(cookie => cookie.trim())
        .filter(cookie => cookie && ![...blockedCookies].some(name => cookie.split('=')[0] === name || cookie.split('=')[0]?.startsWith(name + '.')))
      if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie')
      headers.delete('content-length')
      headers.set('host', preview.host)
      headers.set('x-forwarded-host', preview.host)
      headers.set('x-forwarded-proto', preview.protocol.slice(0, -1))
      const upstreamUrl = new URL(target)
      upstreamUrl.pathname = incoming.pathname
      upstreamUrl.search = incoming.search
      const upstream = await fetchUpstream(new Request(upstreamUrl, {
        method: request.method, headers, body, redirect: 'manual', signal: controller.signal,
      }))
      const responseHeaders = new Headers(upstream.headers)
      // Readiness must distinguish app auth responses from this proxy's own denial.
      responseHeaders.set('x-wrenly-preview-upstream', '1')
      // Fetch decodes compressed bodies; prevent browsers decoding the stream twice.
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      stripHopHeaders(responseHeaders)
      responseHeaders.delete('set-cookie')
      for (const cookie of upstream.headers.getSetCookie()) {
        const name = cookie.slice(0, cookie.indexOf('='))
        if (!blockedCookies.has(name) && !/;\s*domain\s*=/i.test(cookie)) responseHeaders.append('set-cookie', cookie)
      }
      const location = responseHeaders.get('location')
      if (location) {
        const redirect = new URL(location, upstreamUrl)
        if (redirect.origin === target.origin) {
          redirect.protocol = preview.protocol; redirect.hostname = preview.hostname; redirect.port = preview.port
          responseHeaders.set('location', redirect.toString())
        }
      }
      if (!upstream.body) { dispose(); return new Response(null, { status: upstream.status, headers: responseHeaders }) }
      const reader = upstream.body.getReader()
      const abortResponse = (): void => { void reader.cancel().catch(() => {}) }
      controller.signal.addEventListener('abort', abortResponse, { once: true })
      if (controller.signal.aborted) abortResponse()
      const finishResponse = (): void => {
        controller.signal.removeEventListener('abort', abortResponse)
        dispose()
        reader.releaseLock()
      }
      let received = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(output): Promise<void> {
          try {
            const { done, value } = await reader.read()
            if (controller.signal.aborted) throw new Error('Preview response aborted.')
            if (done) { finishResponse(); output.close(); return }
            received += value.byteLength
            if (received > responseLimit) throw new Error('Preview response limit exceeded.')
            output.enqueue(value)
          } catch {
            controller.abort()
            await reader.cancel().catch(() => {})
            finishResponse()
            output.error(new Error('Preview response interrupted.'))
          }
        },
        async cancel(): Promise<void> {
          try { controller.abort(); await reader.cancel() }
          catch { /* Upstream may already have aborted. */ }
          finally { finishResponse() }
        },
      })
      return new Response(stream, { status: upstream.status, headers: responseHeaders })
    } catch (error) {
      controller.abort(); dispose()
      return Response.json({ error: error instanceof RequestBodyLimitError ? 'Preview request body is too large.'
        : timedOut ? 'Preview request timed out.' : 'Preview runtime is unavailable.' },
      { status: error instanceof RequestBodyLimitError ? 413 : timedOut ? 504 : 502 })
    }
  }
}
