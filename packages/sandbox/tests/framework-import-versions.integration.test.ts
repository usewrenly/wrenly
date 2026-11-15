/** Native compatibility checks keep imported dependency versions intact through each runtime phase. */
import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { resolve } from 'node:path'
import { runSandbox } from '../src/index'
import { buildRuntimeArtifact, cleanupRuntimeArtifactPreparation } from '../src/artifacts/runtime-artifact'
import { startPreviewRuntime, cleanupPreviewRuntime } from '../src/previews/runtime'
import { laravelFixture } from './laravel-fixture'

const integration = process.env.WRENLY_TEST_IMPORT_VERSIONS === 'true' ? describe : describe.skip
const docker = new Docker({ socketPath: '/var/run/docker.sock' })
const ACCEPTANCE_TIMEOUT_MS = 300_000

type Fixture = { stack: 'nextjs' | 'laravel'; version: string; files: Array<{ path: string; content: string }> }
function fixtures(): Fixture[] {
  const laravel = laravelFixture().map(file => file.path === 'composer.json' ? {
    ...file, content: JSON.stringify({ ...JSON.parse(file.content), require: { php: '^8.4', 'laravel/framework': '^12.0' } }),
  } : file)
  return [
    { stack: 'nextjs', version: '16.4.5', files: [
      { path: 'package.json', content: JSON.stringify({ name: 'import-version-fixture', private: true,
        scripts: { build: 'next build', start: 'next start --hostname 0.0.0.0 --port 3000' },
        dependencies: { next: '16.4.5', react: '19.2.0', 'react-dom': '19.2.0' } }) },
      { path: 'app/layout.jsx', content: 'export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html> }' },
      { path: 'app/page.jsx', content: 'export default function Page() { return <main><h1>Version preserved</h1></main> }' },
      { path: 'next.config.mjs', content: 'export default { experimental: { cpus: 1 } }' },
    ] },
    { stack: 'laravel', version: '12', files: laravel },
  ]
}

integration('imported framework versions', () => {
  for (const fixture of fixtures()) {
    test(`${fixture.stack} ${fixture.version} builds, previews and packages without upgrading`, async () => {
      const original = JSON.stringify(fixture.files)
      const result = await runSandbox({ projectId: crypto.randomUUID(), stack: fixture.stack, files: fixture.files })
      if (!result.success) throw new Error(`${result.error}\n${result.output}`)
      expect(result.success).toBe(true)
      const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../../apps/api/src/modules/previews/gateway/preview-ingress.ts')], target: 'bun' })
      if (!bundle.success || !bundle.outputs[0]) throw new Error('Fixture ingress bundle failed.')
      const identity = { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() }
      try {
        const runtime = await startPreviewRuntime({ identity, stack: fixture.stack, files: fixture.files,
          ingressBundle: new Uint8Array(await bundle.outputs[0].arrayBuffer()),
          ingress: { previewOrigin: 'http://fixture-version.localhost:3003', controlOrigin: 'http://localhost:3000', capability: 'e'.repeat(64), blockedCookieNames: [] } })
        const response = await fetch(runtime.ingressUrl, { headers: { host: 'fixture-version.localhost:3003', 'x-wrenly-preview-ingress': 'e'.repeat(64) } })
        expect(response.status).toBe(200)
        expect(await response.text()).toContain(fixture.stack === 'nextjs' ? 'Version preserved' : 'Équipe, together.')
      } finally { await cleanupPreviewRuntime(identity) }
      const deploymentId = crypto.randomUUID()
      let imageId: string | undefined
      try {
        const artifact = await buildRuntimeArtifact({ deploymentId, stack: fixture.stack, files: fixture.files,
          signal: new AbortController().signal, beforeEffect: async () => {} })
        imageId = artifact.imageId
        const image = await docker.getImage(imageId).inspect()
        expect(image.Config.Labels?.['io.wrenly.deployment-id']).toBe(deploymentId)
        expect(image.Config.User).toBe('1000:1000')
      } finally {
        await cleanupRuntimeArtifactPreparation(deploymentId)
        if (imageId) await docker.getImage(imageId).remove({ force: true })
      }
      expect(JSON.stringify(fixture.files)).toBe(original)
    }, ACCEPTANCE_TIMEOUT_MS)
  }
})
