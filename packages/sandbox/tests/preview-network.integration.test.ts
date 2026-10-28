// Controlled topology probe. This explicitly does NOT approve generated-app activation.
import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { networkInterfaces, tmpdir } from 'os'
import { chmod, mkdtemp, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { previewResourceLabels, resolvePreviewAppTarget } from '../src/previews/target'
import { previewNetworkOptions } from '../src/previews/network'

const integration = process.env.WRENLY_TEST_DOCKER === 'true' ? describe : describe.skip
integration('preview network boundary probes', () => {
  test.each(['internal', 'isolated'] as const)('%s bridge host boundary', async (mode) => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const nonce = crypto.randomUUID()
    const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response(nonce) })
    let network: Docker.Network | undefined
    let container: Docker.Container | undefined
    try {
      network = await docker.createNetwork({ Name: `wrenly-preview-probe-${nonce}`, Internal: true,
        Driver: 'bridge', EnableIPv6: false,
        Options: mode === 'isolated' ? { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } : {}, Labels: { 'io.wrenly.test': nonce } })
      const info = await network.inspect()
      const subnet = info.IPAM.Config?.[0]?.Subnet
      if (!subnet) throw new Error('Probe network has no subnet.')
      const octets = subnet.split('/')[0]!.split('.').map(Number)
      if (octets.length !== 4 || octets[3] !== 0) throw new Error('Unsupported probe subnet.')
      octets[3] = 1
      const gateway = info.IPAM.Config?.[0]?.Gateway ?? octets.join('.')
      const targets = [...new Set([gateway, ...Object.values(networkInterfaces()).flatMap(entries =>
        (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address))])] 
      const script = `
        const routes = await Bun.file('/proc/net/route').text();
        const defaultRoute = routes.split('\\n').slice(1).some(line => line.trim().split(/\\s+/)[1] === '00000000');
        let hostReachable = false;
        const targets = ${JSON.stringify(targets)};
        const responses = await Promise.all(targets.map(async host => {
          try { return await (await fetch('http://' + host + ':' + ${server.port}, {signal: AbortSignal.timeout(500)})).text() === ${JSON.stringify(nonce)}; } catch { return false }
        }));
        hostReachable = responses.some(Boolean);
        console.log(JSON.stringify({defaultRoute, hostReachable}));
      `
      container = await docker.createContainer({ Image: 'oven/bun:alpine', Cmd: ['bun', '-e', script],
        Labels: { 'io.wrenly.test': nonce },
        HostConfig: { NetworkMode: network.id, Memory: 128 * 1024 * 1024, NanoCpus: 1_000_000_000,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true, PidsLimit: 64 } })
      await container.start()
      const result = await container.wait()
      expect(result.StatusCode).toBe(0)
      const output = (await container.logs({ stdout: true, stderr: true })).toString()
      const match = output.match(/\{"defaultRoute":(true|false),"hostReachable":(true|false)\}/)
      if (!match) throw new Error('Network fixture did not return a usable probe result.')
      expect(match[1]).toBe('false')
      // This host uses Linux Docker bridge networking. Record the actual host reachability,
      // rather than turning absent default routes into a false security assertion.
      process.stderr.write(`Preview network probe: defaultRoute=${match[1]}, hostReachable=${match[2]}\n`)
      expect(match[2]).toBe(mode === 'isolated' ? 'false' : 'true')
    } finally {
      try { if (container) await container.remove({ force: true, v: true }) }
      finally { try { if (network) await network.remove() } finally { await server.stop(true) } }
    }
  }, 15_000)
  test('fixed ingress can reach an isolated app while cross-network access stays blocked', async () => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const identity = crypto.randomUUID()
    const resourceIdentity = { previewId: identity, projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() }
    const capability = 'c'.repeat(64)
    const previewOrigin = 'http://preview-fixture.localhost:3003'
    const bundleDirectory = await mkdtemp(join(tmpdir(), 'wrenly-ingress-fixture-'))
    const networks: Docker.Network[] = []
    const containers: Docker.Container[] = []
    const hardened = { Memory: 128 * 1024 * 1024, NanoCpus: 1_000_000_000,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true, PidsLimit: 64 }
    try {
      const appNetwork = await docker.createNetwork({ ...previewNetworkOptions(identity), Labels: previewResourceLabels(resourceIdentity, 'network') })
      networks.push(appNetwork)
      const ingressNetwork = await docker.createNetwork({ Name: `wrenly-ingress-probe-${identity}`, Driver: 'bridge',
        Labels: { 'io.wrenly.test': identity } })
      networks.push(ingressNetwork)
      const appScript = `let aborted = 0; Bun.serve({hostname:'0.0.0.0', port:3000, async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/probe') {
          let reached = false;
          try { await fetch(url.searchParams.get('target'), {signal: AbortSignal.timeout(500)}); reached = true } catch {}
          return Response.json({reached});
        }
        if (url.pathname === '/echo') return Response.json({ method: request.method, body: await request.text(), headers: Object.fromEntries(request.headers) });
        if (url.pathname === '/redirect') return new Response(null, {status:302, headers:{location: '/echo', 'set-cookie':'control-session=spoof; Path=/'}});
        if (url.pathname === '/compressed') return new Response(Bun.gzipSync(new TextEncoder().encode('decoded payload')), {headers:{'content-encoding':'gzip'}});
        if (url.pathname === '/status') return Response.json({aborted});
        if (url.pathname === '/stall') {
          request.signal.addEventListener('abort', () => { aborted++; }, {once:true});
          return new Response(new ReadableStream({start(output) { output.enqueue(new TextEncoder().encode('first')); }, cancel() { aborted++; }}));
        }
        if (url.pathname === '/stream') return new Response(new ReadableStream({async start(output) { output.enqueue(new TextEncoder().encode('first')); await Bun.sleep(300); output.enqueue(new TextEncoder().encode('last')); output.close(); }}));
        return new Response(${JSON.stringify(identity)});
      }});`
      const app = await docker.createContainer({ Image: 'oven/bun:alpine', Cmd: ['bun', '-e', appScript],
        User: '65534:65534', Labels: previewResourceLabels(resourceIdentity, 'app'), HostConfig: { ...hardened, NetworkMode: appNetwork.id } })
      containers.push(app)
      await app.start()
      const target = resolvePreviewAppTarget(resourceIdentity, await app.inspect(), await appNetwork.inspect())
      const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
      if (!bundle.success || !bundle.outputs[0]) throw new Error('Ingress fixture bundle failed.')
      await Bun.write(join(bundleDirectory, 'ingress.js'), bundle.outputs[0])
      await chmod(bundleDirectory, 0o755)
      await chmod(join(bundleDirectory, 'ingress.js'), 0o644)
      const proxyScript = `import { createPreviewIngressHandler } from '/fixture/ingress.js';
        const handler = createPreviewIngressHandler(${JSON.stringify({ upstream: target, previewOrigin,
          controlOrigin: 'http://localhost:3000', capability, blockedCookieNames: ['control-session', 'preview-grant'], timeoutMs: 1500 })});
        Bun.serve({hostname:'0.0.0.0', port:8080, fetch:handler});`
      const proxy = await docker.createContainer({ Image: 'oven/bun:alpine', Cmd: ['bun', '-e', proxyScript],
        User: '65534:65534', Labels: { 'io.wrenly.test': identity }, ExposedPorts: { '8080/tcp': {} },
        HostConfig: { ...hardened, Binds: [`${bundleDirectory}:/fixture:ro`], NetworkMode: ingressNetwork.id, Sysctls: { 'net.ipv4.ip_forward': '0' },
          PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] } } })
      containers.push(proxy)
      await appNetwork.connect({ Container: proxy.id })
      await proxy.start()
      const proxyInfo = await proxy.inspect()
      const binding = proxyInfo.NetworkSettings.Ports['8080/tcp']?.[0]
      expect(binding?.HostIp).toBe('127.0.0.1')
      if (!binding?.HostPort) throw new Error('No loopback ingress binding.')
      const base = `http://127.0.0.1:${binding.HostPort}`
      const headers = { host: new URL(previewOrigin).host, 'x-wrenly-preview-ingress': capability }
      const send = (path: string, init: RequestInit = {}): Promise<Response> => fetch(base + path, {
        ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) }, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(5000),
      })
      let ready = false
      for (let attempt = 0; attempt < 30 && !ready; attempt++) {
        try { ready = await (await send('/')).text() === identity } catch {}
        if (!ready) await Bun.sleep(100)
      }
      if (!ready) throw new Error(`Ingress fixture readiness failed: ${(await proxy.logs({ stdout: true, stderr: true })).toString()}`)
      expect(ready).toBe(true)
      expect((await fetch(base)).status).toBe(401)
      expect((await send('/', { headers: { host: 'foreign.localhost' } })).status).toBe(403)
      const echoResponse = await send('/echo?q=1', { method: 'POST', body: 'action payload', headers: {
        authorization: 'Bearer control-secret', cookie: 'control-session=secret; app=retained; preview-grant=secret',
        origin: previewOrigin, 'next-action': 'fixture-action', 'x-forwarded-host': 'spoof.localhost',
      } })
      const echo = await echoResponse.json()
      expect(echo.method).toBe('POST')
      expect(echo.body).toBe('action payload')
      expect(echo.headers.host).toBe(new URL(previewOrigin).host)
      expect(echo.headers['x-forwarded-host']).toBe(new URL(previewOrigin).host)
      expect(echo.headers.origin).toBe(previewOrigin)
      expect(echo.headers['next-action']).toBe('fixture-action')
      expect(echo.headers.cookie).toBe('app=retained')
      expect(echo.headers.authorization).toBeUndefined()
      expect(echo.headers['x-wrenly-preview-ingress']).toBeUndefined()
      const redirect = await send('/redirect')
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get('location')).toBe(`${previewOrigin}/echo`)
      expect(redirect.headers.getSetCookie()).toEqual([])
      const compressed = await send('/compressed')
      expect(compressed.headers.has('content-encoding')).toBe(false)
      expect(await compressed.text()).toBe('decoded payload')
      const streamed = await send('/stream')
      const reader = streamed.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toBe('first')
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('last')
      expect((await reader.read()).done).toBe(true)
      reader.releaseLock()
      const stalled = await send('/stall')
      await expect(stalled.text()).rejects.toThrow()
      const priorAborts = (await (await send('/status')).json()).aborted;
      const clientAbort = new AbortController()
      const cancelledResponse = await send('/stall', { signal: clientAbort.signal })
      const cancelReader = cancelledResponse.body!.getReader()
      expect(new TextDecoder().decode((await cancelReader.read()).value)).toBe('first')
      clientAbort.abort()
      await cancelReader.cancel().catch(() => {})
      cancelReader.releaseLock()
      let observedAbort = false
      for (let attempt = 0; attempt < 10 && !observedAbort; attempt++) {
        observedAbort = (await (await send('/status')).json()).aborted > priorAborts
        if (!observedAbort) await Bun.sleep(50)
      }
      expect(observedAbort).toBe(true)
      const ingressName = (await ingressNetwork.inspect()).Name
      const outsideIp = proxyInfo.NetworkSettings.Networks[ingressName]?.IPAddress
      if (!outsideIp) throw new Error('Proxy external address is missing.')
      const probe = await send(`/probe?target=${encodeURIComponent(`http://${outsideIp}:8080`)}`)
      expect((await probe.json()).reached).toBe(false)
    } finally {
      // Reverse creation order: proxies/apps first, networks last.
      try { for (const container of containers.reverse()) await container.remove({ force: true, v: true }) }
      finally {
        try { for (const network of networks.reverse()) await network.remove() }
        finally { await rm(bundleDirectory, { recursive: true, force: true }) }
      }
    }
  }, 20_000)

})
