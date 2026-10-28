import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateWithMcp } from '../../mcp-generation'

const input = { prompt: 'Controlled test', previousErrors: [], attempt: 1 }
async function check(mode: string, invoke: (server: Parameters<typeof generateWithMcp>[0]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wrenly-mcp-test-'))
  const pidFile = join(dir, 'pid')
  try {
    await invoke({ command: process.execPath, args: [join(import.meta.dir, '../fixtures/mcp-generation-server.ts'), pidFile, mode], env: {} })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const integration = process.env.WRENLY_TEST_MCP === 'true' ? describe : describe.skip
integration('bounded MCP subprocess lifecycle', () => {
  test('hard parent crash closes stdin and stops its MCP server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrenly-mcp-crash-'))
    const pidFile = join(dir, 'pid')
    const parent = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/mcp-generation-parent.ts'), pidFile], {
      stdout: 'ignore', stderr: 'ignore', env: {},
    })
    let childPid: number | undefined
    try {
      const startupDeadline = Date.now() + 3000
      while (!existsSync(pidFile) && Date.now() < startupDeadline) await Bun.sleep(10)
      childPid = Number(readFileSync(pidFile, 'utf8'))
      parent.kill('SIGKILL')
      await parent.exited
      const deadline = Date.now() + 3000
      let alive = true
      while (alive && Date.now() < deadline) {
        try { process.kill(childPid, 0) } catch { alive = false }
        if (alive) await Bun.sleep(10)
      }
      expect(alive).toBe(false)
    } finally {
      parent.kill('SIGKILL')
      await parent.exited
      if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* Already exited. */ } }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
  test('returns structured files and confirms server exit', async () => {
    await check('success', async (server) => {
      expect(await generateWithMcp(server, input)).toEqual({ files: [{ path: 'package.json', content: '{}' }] })
    })
  })
  test('deadline includes initialization and reaps the server', async () => {
    await check('initialize-hang', async (server) => {
      await expect(generateWithMcp(server, input, undefined, 500)).rejects.toThrow('deadline')
    })
  }, 10_000)
  test('deadline stops a tool that never returns', async () => {
    await check('tool-hang', async (server) => {
      await expect(generateWithMcp(server, input, undefined, 500)).rejects.toThrow('deadline')
    })
  }, 10_000)
  test('external cancellation closes the actual server process', async () => {
    await check('tool-hang', async (server) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('User cancelled')), 500)
      try { await expect(generateWithMcp(server, input, controller.signal)).rejects.toThrow('User cancelled') }
      finally { clearTimeout(timer) }
    })
  }, 10_000)
})
