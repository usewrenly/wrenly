// Real Laravel MCP subprocess with local fixture inference; never executes generated PHP.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import { generateWithMcp } from '../../mcp-generation'

const integration = process.env.WRENLY_TEST_MCP === 'true' ? describe : describe.skip

integration('Laravel MCP capability verification', () => {
  test('transports source and retry context, edits through the versioned tool while preserving omitted source', async () => {
    const files = [
      { path: 'composer.json', content: '{"require":{"laravel/framework":"^13.0"}}' },
      { path: 'routes/web.php', content: '<?php // fixture, not an executable application' },
    ]
    let calls = 0
    let editing = false
    let finishReason = 'stop'
    let contentOverride: string | undefined
    const provider = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        try {
          calls++
          expect(new URL(request.url).pathname).toBe('/v1/chat/completions')
          const input = await request.json() as { model: string; messages: Array<{ content: string }> }
          expect(input.model).toBe('laravel-fixture')
          expect(input.messages[1]?.content).toContain('Build a team directory')
          expect(input.messages[1]?.content).toContain('Missing controller')
          return Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model: input.model,
            choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: contentOverride ?? JSON.stringify(editing ? { version: 1, operations: [{ type: 'update', path: 'routes/web.php', content: '<?php // Équipe updated' }] } : files) } }] })
        } catch {
          return new Response('Fixture request did not match the expected inference contract.', { status: 400 })
        }
      },
    })
    const server = {
      command: process.execPath,
      args: ['--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/laravel-agent/src/server.ts')],
      env: { WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
        WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'laravel-fixture', WRENLY_MODEL_NETWORK_SCOPE: 'local' },
    }
    try {
      const input = { prompt: 'Build a team directory', previousErrors: ['Missing controller'], attempt: 2 }
      const generated = await generateWithMcp(server, input, undefined, 5000)
      expect(generated.files).toEqual(expect.arrayContaining(files))
      expect(generated.files.some(file => file.path === 'artisan')).toBe(true)
      expect(calls).toBe(1)
      editing = true
      const edited = await generateWithMcp(server, { ...input, previousFiles: generated.files }, undefined, 5000)
      expect(edited.files.find(file => file.path === 'routes/web.php')?.content).toContain('Équipe updated')
      expect(edited.files.find(file => file.path === 'artisan')).toEqual(generated.files.find(file => file.path === 'artisan'))
      expect(calls).toBe(2)
      for (const reason of ['length', 'content_filter', 'stop']) {
        finishReason = reason
        contentOverride = 'fixture-private-source'
        await expect(generateWithMcp(server, { ...input, previousFiles: generated.files }, undefined, 5000)).rejects.toThrow()
      }
      editing = false
      for (const reason of ['length', 'stop']) {
        finishReason = reason
        try {
          await generateWithMcp(server, input, undefined, 5000)
          throw new Error('Expected generation rejection')
        } catch (error) {
          expect(String(error)).not.toContain('fixture-private-source')
          expect(String(error)).toContain('MCP generation tool reported an error')
        }
      }
      const beforeLegacy = calls
      await expect(generateWithMcp(server, { ...input, previousFiles: files.map(file => file.path === 'composer.json' ?
        { ...file, content: '{"require":{"laravel/framework":"^11.0"}}' } : file) }, undefined, 5000)).rejects.toThrow()
      expect(calls).toBe(beforeLegacy)

    } finally {
      await provider.stop(true)
    }
  }, 15000)
})

integration('Laravel MCP lifecycle', () => {
  test('exits when parent stdin closes without initiating inference', async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, '../../../../../../../packages/agents/laravel-agent/src/server.ts')], {
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
      env: { WRENLY_MODEL_BASE_URL: 'http://127.0.0.1:1/v1', WRENLY_MODEL_API_KEY: 'fixture', WRENLY_MODEL_NAME: 'fixture' },
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try { child.stdin.end(); expect(await child.exited).toBe(0) }
    finally { clearTimeout(timer); child.kill() }
  }, 7000)
})
