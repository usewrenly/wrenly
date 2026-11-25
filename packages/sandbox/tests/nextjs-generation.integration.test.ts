// Trusted fixture code executes only inside the existing isolated Docker sandbox.
import { describe, expect, test } from 'bun:test'
import { runSandbox } from '../src/index'
import { nextjs16Fixture } from './nextjs-generation-fixture'

const integration = process.env.WRENLY_TEST_DOCKER === 'true' ? describe : describe.skip

integration('Next.js 16 generation offline build', () => {
  test('installs Next.js 16 + React 19.2 + Tailwind 3.4 and builds with network disabled', async () => {
    const result = await runSandbox({
      projectId: crypto.randomUUID(),
      stack: 'nextjs',
      files: nextjs16Fixture(),
    })
    if (!result.success) {
      throw new Error(`${result.error ?? 'Sandbox failed'}\n${result.output}`)
    }
    expect(result.success).toBe(true)
    expect(result.output).toContain('Building with network disabled')
  }, 300_000)
})
