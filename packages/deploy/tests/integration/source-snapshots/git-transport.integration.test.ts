// Trusted local Git HTTP fixture; generated source is never executed.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushPrivateSnapshot } from '../../../src/source-snapshots/git-transport'
const integration = process.env.WRENLY_TEST_DEPLOY_HTTP === 'true' ? describe : describe.skip
integration('private Git snapshot transport', () => {
  test('pushes private source with deterministic commits and fixed-origin authentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrenly-git-fixture-'))
    let requests = 0
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      await mkdir(join(root, 'apps'))
      const repo = join(root, 'apps', 'project.git')
      const init = Bun.spawn(['git', 'init', '--bare', repo], { stdout: 'ignore', stderr: 'ignore' })
      expect(await init.exited).toBe(0)
      const configure = Bun.spawn(['git', '--git-dir', repo, 'config', 'http.receivepack', 'true'], { stdout: 'ignore', stderr: 'ignore' })
      expect(await configure.exited).toBe(0)
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
        requests++
        if (request.headers.get('authorization') !== `Basic ${Buffer.from('fixture:private-token').toString('base64')}`)
          return new Response('Unauthorized', { status: 401 })
        const url = new URL(request.url)
        const bytes = new Uint8Array(await request.arrayBuffer())
        const process = Bun.spawn(['git', 'http-backend'], { env: { PATH: globalThis.process.env.PATH,
          GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REMOTE_USER: 'fixture',
          CONTENT_TYPE: request.headers.get('content-type') ?? '', CONTENT_LENGTH: String(bytes.byteLength),
          HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '' }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
        process.stdin.write(bytes); process.stdin.end()
        const output = Buffer.from(await new Response(process.stdout).arrayBuffer())
        await process.exited
        const boundary = output.indexOf('\r\n\r\n')
        if (boundary < 0) return new Response('Invalid CGI', { status: 500 })
        const headers = new Headers(); let status = 200
        for (const line of output.subarray(0, boundary).toString().split('\r\n')) {
          const separator = line.indexOf(':')
          const name = line.slice(0, separator); const value = line.slice(separator + 1).trim()
          if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
          else headers.set(name, value)
        }
        return new Response(output.subarray(boundary + 4), { status, headers })
      } })
      const input = { repositoryUrl: `http://127.0.0.1:${server.port}/apps/project.git`, username: 'fixture', token: 'private-token',
        files: [{ path: '.gitignore', content: 'app/\n' }, { path: 'app/page.tsx', content: 'trusted data, never executed' }] }
      const first = await pushPrivateSnapshot(input, new AbortController().signal)
      const second = await pushPrivateSnapshot(input, new AbortController().signal)
      expect(first).toMatch(/^[a-f0-9]{40}$/); expect(second).toBe(first)
      const show = Bun.spawn(['git', '--git-dir', repo, 'show', 'main:app/page.tsx'], { stdout: 'pipe', stderr: 'ignore' })
      expect(await new Response(show.stdout).text()).toBe('trusted data, never executed')
      expect(await show.exited).toBe(0); expect(requests).toBeGreaterThan(0)
      await expect(pushPrivateSnapshot({ ...input, files: [{ path: '../escape', content: 'private' }] }, new AbortController().signal)).rejects.toThrow('Private Git snapshot operation failed')
    } finally { await server?.stop(true); await rm(root, { recursive: true, force: true }) }
  }, 20_000)
})
