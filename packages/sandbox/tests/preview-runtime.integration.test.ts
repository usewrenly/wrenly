import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { resolve } from 'path'
import { cleanupPreviewRuntime, startPreviewRuntime, type PreviewRuntimeInput } from '../src/previews/runtime'
import { previewResourceLabels } from '../src/previews/target'

const integration = process.env.WRENLY_TEST_DOCKER === 'true' ? describe : describe.skip
const docker = new Docker({ socketPath: '/var/run/docker.sock' })
async function input(script = "Bun.serve({hostname:'0.0.0.0',port:3000,fetch:()=>new Response('fixture ready')})", build = "await Bun.write('prepared.txt','built in volume')"): Promise<PreviewRuntimeInput> {
  const bundled = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
  if (!bundled.success || !bundled.outputs[0]) throw new Error('Could not bundle trusted fixture ingress.')
  return { identity: { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() },
    files: [{ path: 'package.json', content: JSON.stringify({ scripts: { build: 'bun build.ts', start: 'bun app.ts' } }) },
      { path: 'build.ts', content: build }, { path: 'app.ts', content: script }],
    ingressBundle: new Uint8Array(await bundled.outputs[0].arrayBuffer()),
    ingress: { previewOrigin: 'http://fixture-runtime.localhost:3003', controlOrigin: 'http://localhost:3000', capability: 'd'.repeat(64), blockedCookieNames: ['control-session'] },
    preparationTimeoutMs: 15_000, readinessTimeoutMs: 3000 }
}
async function expectClean(identity: PreviewRuntimeInput['identity']): Promise<void> {
  const labels = previewResourceLabels(identity, 'app'); delete labels['io.wrenly.preview-role']
  const filters = JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) })
  expect(await docker.listContainers({ all: true, filters })).toHaveLength(0)
  expect(await docker.listNetworks({ filters })).toHaveLength(0)
  expect((await docker.listVolumes({ filters })).Volumes ?? []).toHaveLength(0)
}

integration('Docker preview runtime adapter (controlled Bun fixtures, not generated Next.js)', () => {
  test('prepares once in a volume, serves through protected ingress and cleans only owned resources', async () => {
    const fixture = await input(`Bun.serve({hostname:'0.0.0.0',port:3000,async fetch() { return Response.json({ prepared: await Bun.file('prepared.txt').text(), env: process.env.WRENLY_TEST_SECRET ?? null }); }})`)
    fixture.files[0]!.content = JSON.stringify({ scripts: { build: 'bun build.ts', start: 'bun app.ts' },
      devDependencies: { 'fixture-tool': 'file:./tool' }, trustedDependencies: ['fixture-tool'] })
    fixture.files.push({ path: 'tool/package.json', content: JSON.stringify({ name: 'fixture-tool', version: '1.0.0', main: 'index.ts',
      scripts: { postinstall: "bun -e \"await Bun.write('/app/script-ran','unsafe')\"" } }) },
      { path: 'tool/index.ts', content: "export const prepared = 'built in volume'" })
    fixture.files.find(file => file.path === 'build.ts')!.content = "import {prepared} from 'fixture-tool'; if(await Bun.file('/app/script-ran').exists()) throw new Error('Lifecycle script ran'); await Bun.write('prepared.txt',prepared)"
    const other = await input()
    const untouchedName = `wrenly-fixture-other-${other.identity.previewId}`
    await docker.createVolume({ Name: untouchedName, Labels: previewResourceLabels(other.identity, 'workspace') })
    const untouched = docker.getVolume(untouchedName)
    let started = false
    fixture.onStarted = async (resources, metadata) => {
      expect((await docker.getContainer(resources.appContainerId).inspect()).State.Running).toBe(true)
      expect(metadata.lockfileSha256).toMatch(/^[a-f0-9]{64}$/)
      started = true
    }
    process.env.WRENLY_TEST_SECRET = 'must never reach fixture'
    try {
      const result = await startPreviewRuntime(fixture)
      expect(started).toBe(true)
      expect(result.imageId.startsWith('sha256:')).toBe(true)
      expect(result.lockfileSha256).toMatch(/^[a-f0-9]{64}$/)
      const app = await docker.getContainer(result.resources.appContainerId).inspect()
      expect(app.HostConfig.ReadonlyRootfs).toBe(true)
      expect(app.Config.User).toBe('65534:65534')
      expect(Object.values(app.NetworkSettings.Networks)).toHaveLength(1)
      expect(app.Mounts.every(mount => mount.Type === 'volume')).toBe(true)
      expect((await fetch(result.ingressUrl)).status).toBe(401)
      const response = await fetch(result.ingressUrl, { headers: { host: 'fixture-runtime.localhost:3003', 'x-wrenly-preview-ingress': fixture.ingress.capability } })
      expect(await response.json()).toEqual({ prepared: 'built in volume', env: null })
      // Duplicate startup must not remove an already-owned live runtime.
      await expect(startPreviewRuntime(fixture)).rejects.toThrow()
      expect((await docker.getContainer(result.resources.appContainerId).inspect()).State.Running).toBe(true)
      await cleanupPreviewRuntime(fixture.identity)
      await cleanupPreviewRuntime(fixture.identity)
      await expectClean(fixture.identity)
      expect((await untouched.inspect()).Name).toBe(`wrenly-fixture-other-${other.identity.previewId}`)
    } finally { delete process.env.WRENLY_TEST_SECRET; await cleanupPreviewRuntime(fixture.identity); await untouched.remove() }
  }, 30_000)

  test.each(['build failure', 'readiness failure', 'redirect loop', 'abort', 'handoff failure'] as const)('%s retains diagnostics and leaves no resources', async scenario => {
    const fixture = await input(scenario === 'readiness failure' ? "Bun.serve({port:3000,fetch:()=>new Response('not ready',{status:503})})"
      : scenario === 'redirect loop' ? "Bun.serve({port:3000,fetch:()=>new Response(null,{status:302,headers:{location:'/'}})})"
      : "Bun.serve({port:3000,fetch:()=>new Response('ok')})",
    scenario === 'build failure' ? "console.error('controlled build failure');process.exit(1)" : scenario === 'abort' ? "console.log('abort fixture started');await Bun.sleep(10000)" : "console.log('offline build fixture')")
    fixture.readinessTimeoutMs = 3000
    let output = ''
    const controller = new AbortController()
    fixture.signal = controller.signal
    if (scenario === 'handoff failure') fixture.onStarted = async () => { throw new Error('Controlled persistence handoff failure') }
    fixture.onOutput = chunk => { output += chunk; if (scenario === 'abort' && chunk.includes('abort fixture started')) controller.abort() }
    try {
      await expect(startPreviewRuntime(fixture)).rejects.toThrow('Preview')
      expect(output).toContain(scenario === 'build failure' ? 'controlled build failure' : scenario === 'abort' ? 'abort fixture started' : 'offline build fixture')
      if (scenario === 'readiness failure' || scenario === 'redirect loop') expect(output).toContain('Waiting for isolated preview HTTP readiness')
      await expectClean(fixture.identity)
    } finally { await cleanupPreviewRuntime(fixture.identity) }
  }, 25_000)
})

const nextIntegration = process.env.WRENLY_TEST_DOCKER === 'true' && process.env.WRENLY_TEST_NEXT_PREVIEW === 'true' ? describe : describe.skip
nextIntegration('Next.js preview runtime acceptance (installs pinned repository versions)', () => {
  test('serves a server-rendered page and executes a form server action', async () => {
    const fixture = await input()
    fixture.preparationTimeoutMs = 300_000
    fixture.readinessTimeoutMs = 30_000
    fixture.files = [
      { path: 'package.json', content: JSON.stringify({ scripts: { build: 'next build --webpack', start: 'next start' },
        dependencies: { next: '16.3.4', react: '19.2.8', 'react-dom': '19.2.8' } }) },
      { path: 'next.config.mjs', content: 'export default {experimental:{cpus:1}}' },
      { path: 'app/layout.jsx', content: 'export default function Layout({children}) { return <html><body>{children}</body></html> }' },
      { path: 'app/actions.js', content: "'use server'; import {redirect} from 'next/navigation'; export async function submit(data) {redirect('/submitted?value='+encodeURIComponent(data.get('value')??''))}" },
      { path: 'app/page.jsx', content: "import {submit} from './actions'; export const dynamic='force-dynamic'; export default function Page(){return <main>Server rendered preview<form action={submit}><input name='value'/><button>Submit</button></form></main>}" },
      { path: 'app/submitted/page.jsx', content: "export default function Page(){return <main>Action submitted</main>}" },
    ]
    fixture.onOutput = chunk => process.stderr.write(chunk)
    try {
      const result = await startPreviewRuntime(fixture)
      const headers = { host: 'fixture-runtime.localhost:3003', 'x-wrenly-preview-ingress': fixture.ingress.capability }
      const html = await (await fetch(result.ingressUrl, { headers })).text()
      expect(html).toContain('Server rendered preview')
      const actionId = html.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1]
      expect(actionId).toBeDefined()
      if (!actionId) throw new Error('Missing form server action identifier.')
      const form = new FormData()
      form.set(actionId, ''); form.set('value', 'preview action works')
      const action = await fetch(result.ingressUrl, { method: 'POST', body: form, redirect: 'manual', headers: { ...headers, origin: fixture.ingress.previewOrigin } })
      expect(action.status).toBe(303)
      expect(action.headers.get('location')).toContain('/submitted?value=preview%20action%20works')
    } finally { await cleanupPreviewRuntime(fixture.identity); await expectClean(fixture.identity) }
  }, 360_000)
})
