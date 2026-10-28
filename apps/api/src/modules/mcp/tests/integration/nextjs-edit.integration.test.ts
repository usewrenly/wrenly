// Real MCP server and trusted local inference fixture; no model or generated app execution.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { generateWithMcp } from '../../mcp-generation'
const integration = process.env.WRENLY_TEST_MCP === 'true' ? describe : describe.skip
integration('Next.js MCP revision editing', () => {
  test('uses the real versioned tool and preserves files omitted by the model', async () => {
    let calls = 0
    let invalidOutput = false
    let providerError = false
    let finishReason = 'stop'
    let contentOverride: string | undefined
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      calls++
      expect(new URL(request.url).pathname).toBe('/v1/chat/completions')
      const input = await request.json() as { messages: Array<{ content: string }> }
      expect(input.messages[1]?.content).toContain('Unrelated functionality')
      if (providerError) return new Response('provider-private-detail', { status: 500 })
      return Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: contentOverride ?? JSON.stringify(invalidOutput ? { version: 2, private: 'provider-private-detail', operations: [] } : { version: 1, operations: [{ type: 'update', path: 'app/page.tsx', content: 'Changed heading' }] }) } }] })
    } })
    const base = [{ path: 'package.json', content: '{}' }, { path: 'app/page.tsx', content: 'Original heading' }, { path: 'app/keep.tsx', content: 'Unrelated functionality' }]
    try {
      const output = await generateWithMcp({ command: process.execPath, args: ['--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/nextjs-agent/src/server.ts')],
        env: { WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'fixture' } },
      { prompt: 'Change the heading', previousFiles: base, previousErrors: [], attempt: 1 }, undefined, 5000)
      expect(calls).toBe(1)
      expect(output.files.find(file => file.path === 'app/keep.tsx')?.content).toBe('Unrelated functionality')
      expect(output.files.find(file => file.path === 'app/page.tsx')?.content).toBe('Changed heading')
      expect(base[1]?.content).toBe('Original heading')
      invalidOutput = true
      await expect(generateWithMcp({ command: process.execPath, args: ['--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/nextjs-agent/src/server.ts')],
        env: { WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'fixture' } },
      { prompt: 'Change the heading', previousFiles: base, previousErrors: [], attempt: 1 }, undefined, 5000)).rejects.toThrow('structurally invalid file-edit response')
      expect(calls).toBe(2)
      providerError = true
      await expect(generateWithMcp({ command: process.execPath, args: ['--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/nextjs-agent/src/server.ts')],
        env: { WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'fixture' } },
      { prompt: 'Change the heading', previousFiles: base, previousErrors: [], attempt: 1 }, undefined, 5000)).rejects.toThrow('editing model request failed')
      expect(calls).toBe(3)
      providerError = false
      for (const [reason, message] of [['length', 'output limit'], ['content_filter', 'did not finish'], ['stop', 'invalid JSON']]) {
        finishReason = reason!
        contentOverride = 'provider-private-detail'
        try {
          await generateWithMcp({ command: process.execPath, args: ['--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/nextjs-agent/src/server.ts')],
            env: { WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'fixture' } },
          { prompt: 'Change heading', previousFiles: base, previousErrors: [], attempt: 1 }, undefined, 5000)
          throw new Error('Expected edit failure')
        } catch (error) {
          expect(String(error)).toContain(message!)
          expect(String(error)).not.toContain('provider-private-detail')
        }
      }
      expect(calls).toBe(6)
    } finally { await provider.stop(true) }
  }, 10000)
  test('unsupported MCP servers fail without falling back to full regeneration', async () => {
    const { mkdtemp, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const directory = await mkdtemp(resolve(tmpdir(), 'wrenly-edit-unsupported-'))
    try {
      await expect(generateWithMcp({ command: process.execPath,
        args: ['--no-env-file', resolve(import.meta.dir, '../fixtures/mcp-generation-server.ts'), resolve(directory, 'pid'), 'success'], env: {} },
      { prompt: 'Change', previousFiles: [{ path: 'package.json', content: '{}' }], previousErrors: [], attempt: 1 }, undefined, 5000)).rejects.toThrow('does not support revision-safe editing')
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 10000)
})

integration('Next.js MCP generation failures', () => {
  test('rejects invalid inputs before inference and hides incomplete/provider output', async () => {
    let calls = 0
    let finishReason = 'stop'
    let content = '[{"path":"app/page.tsx","content":"export default function Page() { return null }"}]'
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      calls++
      return Response.json({ id: 'fixture', choices: [{ finish_reason: finishReason,
        message: { role: 'assistant', content } }] })
    } })
    const server = { command: process.execPath,
      args: ['--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/nextjs-agent/src/server.ts')],
      env: { WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'fixture' } }
    const input = { prompt: 'Build a calendar', attempt: 1, previousErrors: [] }
    try {
      expect((await generateWithMcp(server, input, undefined, 5000)).files).toHaveLength(1)
      const beforeInvalid = calls
      await expect(generateWithMcp(server, { ...input, attempt: 4 }, undefined, 5000)).rejects.toThrow('tool reported an error')
      expect(calls).toBe(beforeInvalid)
      for (const reason of ['length', 'content_filter', 'stop']) {
        finishReason = reason
        content = 'private-generated-content'
        try {
          await generateWithMcp(server, input, undefined, 5000)
          throw new Error('Expected rejection')
        } catch (error) {
          expect(String(error)).toContain('tool reported an error')
          expect(String(error)).not.toContain('private-generated-content')
        }
      }
    } finally { await provider.stop(true) }
  }, 15000)
})
