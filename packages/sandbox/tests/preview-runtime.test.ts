import { expect, test } from 'bun:test'
import { startPreviewRuntime, PreviewRuntimeError, type PreviewRuntimeInput } from '../src/previews/runtime'
import { startPreparedDatabasePreview, type PreparedDatabasePreviewInput } from '../src/previews/database-runtime'

function input(): PreviewRuntimeInput {
  return { identity: { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() },
    files: [{ path: 'package.json', content: '{}' }], ingressBundle: new Uint8Array([1]),
    ingress: { previewOrigin: 'http://preview.localhost:3003', controlOrigin: 'http://localhost:3000', capability: 'a'.repeat(64), blockedCookieNames: [] } }
}
test('prepared database previews refuse invalid identity, role, key and lifetime before starting Docker work', async () => {
  const base = input()
  const resourceId = crypto.randomUUID()
  const prepared: PreparedDatabasePreviewInput = {
    identity: base.identity, framework: 'nextjs', scope: { projectId: base.identity.projectId, resourceId, environment: 'development' },
    socket: { id: base.identity.previewId, projectId: base.identity.projectId, resourceId,
      containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}`, volumeName: `wrenly-database-socket-${base.identity.previewId}` },
    imageId: `sha256:${'c'.repeat(64)}`, role: { user: `wrenly_${resourceId.replaceAll('-', '')}_runtime`, password: 'd'.repeat(64) },
    appKey: null, lifetimeMs: 30_000, applicationBundle: new Uint8Array([1]), ingressBundle: base.ingressBundle,
    ingress: base.ingress, signal: new AbortController().signal, assertHeld: async () => {}, onStarted: async () => {},
  }
  for (const candidate of [
    { ...prepared, signal: AbortSignal.abort() },
    { ...prepared, lifetimeMs: 3_600_001 },
    { ...prepared, applicationBundle: new Uint8Array() },
    { ...prepared, role: { ...prepared.role, user: 'administrator' } },
    { ...prepared, framework: 'laravel' as const, appKey: null },
    { ...prepared, socket: { ...prepared.socket, resourceId: crypto.randomUUID() } },
  ]) await expect(startPreparedDatabasePreview(candidate)).rejects.toThrow('database application startup')
})
test('runtime rejects invalid identities, paths, source and deadlines before Docker access', async () => {
  const fixtures = [input(), input(), input(), input(), input()]
  fixtures[0]!.identity.previewId = '../escape'
  fixtures[1]!.files = [{ path: '../escape', content: '{}' }]
  fixtures[2]!.files = []
  fixtures[3]!.preparationTimeoutMs = 300_001
  fixtures[4]!.readinessTimeoutMs = 60_001
  for (const fixture of fixtures) await expect(startPreviewRuntime(fixture)).rejects.toThrow()
})
test('already aborted runtime request performs no Docker or cleanup operation', async () => {
  const fixture = input()
  fixture.signal = AbortSignal.abort()
  await expect(startPreviewRuntime(fixture)).rejects.toThrow('aborted')
})
test('styling preflight exposes safe repair diagnostics before any Docker operation', async () => {
  const fixture = input()
  fixture.files = [{ path: 'package.json', content: '{"devDependencies":{"tailwindcss":"^3.4.0"}}' }]
  const lines: string[] = []
  fixture.onOutput = text => { lines.push(text) }
  try {
    await startPreviewRuntime(fixture)
    throw new Error('Expected styling rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewRuntimeError)
    expect((error as PreviewRuntimeError).phase).toBe('styling validation')
    expect((error as PreviewRuntimeError).output).toContain('tailwind.config.ts')
    expect(lines.join('')).toContain('tailwind.config.ts')
  }
})
