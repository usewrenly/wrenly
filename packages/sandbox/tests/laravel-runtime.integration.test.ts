import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runSandbox } from '../src/index'
import { buildRuntimeArtifact, cleanupRuntimeArtifactPreparation } from '../src/artifacts/runtime-artifact'
import { startPreviewRuntime, cleanupPreviewRuntime } from '../src/previews/runtime'
import { laravelFixture } from './laravel-fixture'

const integration = process.env.WRENLY_TEST_LARAVEL === 'true' ? describe : describe.skip
const docker = new Docker({ socketPath: '/var/run/docker.sock' })
integration('Laravel offline sandbox, preview and production artifact', () => {
  test('validates a real Blade page and local CSS with no host execution', async () => {
    const result = await runSandbox({ projectId: crypto.randomUUID(), stack: 'laravel', files: laravelFixture() })
    if (!result.success) throw new Error(result.error + '\n' + result.output)
    expect(result.output).toContain('Laravel offline HTTP and local asset validation passed.')
    expect(result.output).toContain('Building with network disabled')
  }, 300_000)

  test.each(['invalid PHP', 'missing local CSS', 'uncompiled CSS'] as const)('%s fails validation with repair diagnostics', async scenario => {
    const files = laravelFixture()
    if (scenario === 'invalid PHP') files.push({ path: 'app/Broken.php', content: '<?php this is invalid PHP;' })
    else if (scenario === 'missing local CSS') files.splice(files.findIndex(file => file.path === 'public/app.css'), 1)
    else {
      files[files.findIndex(file => file.path === 'public/app.css')] = { path: 'public/app.css', content: '@tailwind utilities;' }
      files.push({ path: 'package.json', content: JSON.stringify({ scripts: { build: 'true' } }) })
    }
    const buildId = crypto.randomUUID()
    const result = await runSandbox({ projectId: crypto.randomUUID(), buildId, stack: 'laravel', files })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Build failed')
    expect(result.output).toContain(scenario === 'invalid PHP' ? 'Parse error' : scenario === 'uncompiled CSS' ? 'uncompiled Tailwind CSS' : 'referenced asset did not load')
    expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.build-id=${buildId}`] }) })).toHaveLength(0)
  }, 300_000)

  test('cancellation before install leaves no owned build containers', async () => {
    const controller = new AbortController()
    const buildId = crypto.randomUUID()
    const result = await runSandbox({ projectId: crypto.randomUUID(), buildId, stack: 'laravel', files: laravelFixture(),
      signal: controller.signal, onOutput: text => { if (text.includes('Installing dependencies')) controller.abort() } })
    expect(result.success).toBe(false)
    expect(result.error).toContain('aborted')
    expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.build-id=${buildId}`] }) })).toHaveLength(0)
  })

  test('serves styled UTF-8 Blade through protected ingress and removes owned resources', async () => {
    const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
    if (!bundle.success || !bundle.outputs[0]) throw new Error('Trusted ingress bundle failed.')
    const identity = { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() }
    try {
      const runtime = await startPreviewRuntime({ identity, stack: 'laravel', files: laravelFixture(),
        ingressBundle: new Uint8Array(await bundle.outputs[0].arrayBuffer()),
        ingress: { previewOrigin: 'http://fixture-laravel.localhost:3003', controlOrigin: 'http://localhost:3000',
          capability: 'f'.repeat(64), blockedCookieNames: ['control-session'] } })
      expect((await fetch(runtime.ingressUrl)).status).toBe(401)
      const headers = { host: 'fixture-laravel.localhost:3003', 'x-wrenly-preview-ingress': 'f'.repeat(64) }
      const response = await fetch(runtime.ingressUrl, { headers })
      expect(await response.text()).toContain('Équipe, together.')
      const css = await fetch(runtime.ingressUrl + '/app.css', { headers })
      expect(css.headers.get('content-type')).toContain('text/css')
      expect(await css.text()).toContain('background:#f4f2ec')
      const app = await docker.getContainer(runtime.resources.appContainerId).inspect()
      expect(app.Config.User).toBe('65534:65534')
      expect(app.HostConfig.ReadonlyRootfs).toBe(true)
      expect(Object.values(app.NetworkSettings.Networks)).toHaveLength(1)
      expect(runtime.lockfileSha256).toMatch(/^[a-f0-9]{64}$/)
      if (process.env.WRENLY_TEST_LARAVEL_BROWSER === 'true') {
        const directory = await mkdtemp(resolve(tmpdir(), 'wrenly-laravel-chrome-'))
        const captures = process.env.WRENLY_TEST_LARAVEL_CAPTURES ?? directory
        await mkdir(captures, { recursive: true })
        let report: unknown
        // Fixture-only stand-in for an already authenticated gateway; the real
        // project authorization/gateway suites remain the authority for access.
        const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
          try {
            const url = new URL(request.url)
            if (url.pathname === '/fixture-report') { report = await request.json(); return new Response('ok') }
            const upstream = await fetch(runtime.ingressUrl + url.pathname, { headers })
            if (url.pathname !== '/') return upstream
            const html = await upstream.text()
            return new Response(html.replace('</body>', `<script>window.addEventListener('load',()=>fetch('/fixture-report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({background:getComputedStyle(document.body).backgroundColor,title:document.querySelector('h1').textContent,overflow:document.documentElement.scrollWidth>innerWidth})}));</script></body>`), { headers: { 'content-type': 'text/html; charset=utf-8' } })
          } catch { return new Response('Fixture gateway failed.', { status: 500 }) }
        } })
        let browser: ReturnType<typeof Bun.spawn> | undefined
        try {
          for (const width of [1280, 390]) {
            report = undefined
            browser = Bun.spawn([process.env.WRENLY_TEST_CHROME_PATH ?? '/usr/bin/google-chrome', '--headless=new',
              '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
              `--user-data-dir=${resolve(directory, String(width))}`, `--window-size=${width},900`, '--hide-scrollbars',
              '--virtual-time-budget=3000', `--screenshot=${resolve(captures, `laravel-${width}.png`)}`, gateway.url.href],
              { stdout: 'ignore', stderr: 'ignore' })
            const deadline = Date.now() + 18_000
            while (!report && Date.now() < deadline) await Bun.sleep(25)
            expect(report).toEqual({ background: 'rgb(244, 242, 236)', title: 'Équipe, together.', overflow: false })
            await browser.exited
            browser = undefined
          }
        } finally { browser?.kill(); await browser?.exited; await gateway.stop(true); await rm(directory, { recursive: true, force: true }) }
      }
    } finally { await cleanupPreviewRuntime(identity) }
    expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.preview-id=${identity.previewId}`] }) })).toHaveLength(0)
  }, 300_000)

  test('retains a runnable exact image without keys, source mounts or remote rebuilding', async () => {
    const deploymentId = crypto.randomUUID()
    let imageId: string | undefined
    let container: Docker.Container | undefined
    let checkedMounts = 0
    try {
      const files = laravelFixture()
      files.find(file => file.path === 'routes/web.php')!.content += "\nRoute::get('/fixture-key-proof', fn() => hash('sha256', config('app.key')));\n"
      // Exercise cleanup of validation-time values created by an offline asset hook.
      files.push({ path: 'package.json', content: JSON.stringify({ scripts: { build: 'php artisan config:cache && php build.php' } }) },
        { path: 'build.php', content: "<?php file_put_contents(__DIR__.'/.env', 'APP_KEY='.getenv('APP_KEY'));" })
      const runtimeKey = 'base64:' + Buffer.alloc(32, 1).toString('base64')
      const expectedKeyHash = createHash('sha256').update(runtimeKey).digest('hex')
      const artifact = await buildRuntimeArtifact({ deploymentId, stack: 'laravel', files,
        signal: new AbortController().signal, beforeEffect: async () => {
          const preparations = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.deployment-id=${deploymentId}`] }) })
          for (const preparation of preparations) {
            const mounted = (await docker.getContainer(preparation.Id).inspect()).Mounts.filter(mount => mount.Type === 'volume')
            for (const mount of mounted) { expect(mount.Name).toBe(`wrenly-artifact-${deploymentId}`); checkedMounts++ }
          }
        } })
      expect(checkedMounts).toBeGreaterThan(0)
      imageId = artifact.imageId
      const image = await docker.getImage(imageId).inspect()
      expect(image.Config.Cmd).toEqual(['frankenphp', 'run', '--config', '/wrenly/Caddyfile'])
      expect(image.Config.Env?.some(value => value.startsWith('APP_KEY='))).toBe(false)
      expect(image.Config.User).toBe('1000:1000')
      container = await docker.createContainer({ Image: imageId,
        Env: ['APP_KEY=' + runtimeKey],
        HostConfig: { NetworkMode: 'none', Memory: 2 * 1024 ** 3, NanoCpus: 2_000_000_000,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] } })
      await container.start()
      const httpProbe = await container.exec({ Cmd: ['bun', '-e', `for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:3000');const m=await fetch('http://127.0.0.1:3000/.well-known/wrenly-deployment');const html=await r.text();const marker=await m.text();const proof=await(await fetch('http://127.0.0.1:3000/fixture-key-proof')).text();if(html.includes('Équipe')&&marker==='${deploymentId}'&&proof==='${expectedKeyHash}'&&!await Bun.file('/app/.env').exists()&&!await Bun.file('/app/bootstrap/cache/config.php').exists())process.exit(0);if(i===59)console.log(JSON.stringify({status:r.status,html:html.slice(0,120),markerStatus:m.status,marker:marker.slice(0,120)}))}catch{}await Bun.sleep(100)}process.exit(1)`], AttachStdout: true, AttachStderr: true })
      const stream = await httpProbe.start({})
      let output = ''
      await new Promise<void>((resolve, reject) => { stream.on('data', (chunk: Buffer) => { output += chunk.toString() }); stream.once('end', resolve); stream.once('error', reject) })
      if ((await httpProbe.inspect()).ExitCode !== 0) throw new Error('Artifact HTTP failed: ' + output + String(await container.logs({ stdout: true, stderr: true, tail: 200 })))
      expect((await httpProbe.inspect()).ExitCode).toBe(0)
      expect((await container.inspect()).Mounts).toHaveLength(0)
    } finally {
      await container?.remove({ force: true, v: true })
      await cleanupRuntimeArtifactPreparation(deploymentId)
      if (imageId) await docker.getImage(imageId).remove({ force: true })
    }
  }, 300_000)
})
