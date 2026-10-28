import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { runSandbox, SandboxProgressError } from '../src/index'

const integration = process.env.WRENLY_TEST_DOCKER === 'true' ? describe : describe.skip
integration('Docker sandbox boundaries', () => {
  const docker = new Docker({ socketPath: '/var/run/docker.sock' })
  const projectId = crypto.randomUUID()
  function input(script: string): Parameters<typeof runSandbox>[0] {
    return {
      projectId, buildId: crypto.randomUUID(), claimToken: crypto.randomUUID(), stack: 'nextjs',
      files: [
        { path: 'package.json', content: JSON.stringify({ name: 'sandbox-test', scripts: { build: 'bun run verify.ts' } }) },
        { path: 'verify.ts', content: script },
      ],
    }
  }
  async function assertClean(buildId: string): Promise<void> {
    const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.build-id=${buildId}`] }) })
    expect(containers).toHaveLength(0)
  }
  test('validates offline and captures stdout/stderr without leaving containers', async () => {
    const request = input(`import { networkInterfaces } from 'os';
      if (Object.keys(networkInterfaces()).some(name => name !== 'lo')) throw new Error('Build has networking');
      console.log('NETWORK_DISABLED'); console.error('STDERR_CAPTURED');`)
    const result = await runSandbox(request)
    expect(result.success).toBe(true)
    expect(result.output).toContain('NETWORK_DISABLED')
    expect(result.output).toContain('STDERR_CAPTURED')
    await assertClean(request.buildId!)
  }, 20_000)
  test('installation suppresses root and explicitly trusted dependency lifecycle scripts', async () => {
    const request = input(`if (await Bun.file('INSTALL_HOOK_RAN').exists()) throw new Error('Installation hook executed'); console.log('INSTALL_HOOKS_DISABLED')`)
    request.files[0]!.content = JSON.stringify({ name: 'sandbox-hooks-test',
      scripts: { preinstall: "touch INSTALL_HOOK_RAN", postinstall: "touch INSTALL_HOOK_RAN", build: 'bun run verify.ts' },
      dependencies: { 'fixture-hook': 'file:./fixture-hook' }, trustedDependencies: ['fixture-hook'] })
    request.files.push({ path: 'fixture-hook/package.json', content: JSON.stringify({ name: 'fixture-hook', version: '1.0.0',
      scripts: { postinstall: 'touch /app/INSTALL_HOOK_RAN' } }) })
    const result = await runSandbox(request)
    expect(result.success).toBe(true)
    expect(result.output).toContain('INSTALL_HOOKS_DISABLED')
    await assertClean(request.buildId!)
  }, 20_000)
  test('forwards decoded Docker output before execution completes', async () => {
    const request = input(`console.log('LIVE_BEGIN'); await Bun.sleep(1200); console.log('LIVE_END')`)
    let beginning: number | undefined
    let elapsed: number | undefined
    request.onOutput = chunk => {
      if (chunk.includes('LIVE_BEGIN')) { expect(chunk).not.toContain('LIVE_END'); beginning = Date.now() }
      if (chunk.includes('LIVE_END') && beginning) elapsed = Date.now() - beginning
    }
    const result = await runSandbox(request)
    expect(result.success).toBe(true)
    expect(elapsed).toBeGreaterThan(900)
    await assertClean(request.buildId!)
  }, 20_000)
  test('quiet builds can exceed the daemon request idle timeout', async () => {
    const request = { ...input(`await Bun.sleep(11_000); console.log('QUIET_BUILD_COMPLETED')`), timeoutMs: 20_000 }
    const result = await runSandbox(request)
    expect(result.success).toBe(true)
    expect(result.output).toContain('QUIET_BUILD_COMPLETED')
    await assertClean(request.buildId!)
  }, 25_000)
  test('timeout kills execution and retains partial output', async () => {
    const request = { ...input(`console.log('BEFORE_TIMEOUT'); await Bun.sleep(30_000)`), timeoutMs: 3000 }
    const result = await runSandbox(request)
    expect(result.success).toBe(false)
    expect(result.output).toContain('BEFORE_TIMEOUT')
    expect(result.error).toContain('deadline')
    await assertClean(request.buildId!)
  }, 20_000)
  test('external abort stops execution and retains logs', async () => {
    const controller = new AbortController()
    const request = { ...input(`console.log('BEFORE_ABORT'); await Bun.sleep(30_000)`), signal: controller.signal }
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const result = await runSandbox(request)
      expect(result.success).toBe(false)
      expect(result.output).toContain('BEFORE_ABORT')
      await assertClean(request.buildId!)
    } finally { clearTimeout(timer) }
  }, 20_000)
  test('unsafe source is rejected before Docker execution', async () => {
    const request = input('')
    request.files.push({ path: '../escape', content: 'unsafe' })
    const result = await runSandbox(request)
    expect(result.success).toBe(false)
    expect(result.error).toContain('unsafe')
    await assertClean(request.buildId!)
  })
  test('activity boundaries surround actual install/validation and persistence failure prevents execution', async () => {
    const request = input("console.log('VALIDATED_ACTIVITY')")
    const stages: string[] = []
    request.onStage = async (operation, state) => { stages.push(`${operation}:${state}`) }
    expect((await runSandbox(request)).success).toBe(true)
    expect(stages).toEqual(['installation:started','installation:completed','validation:started','validation:completed'])
    await assertClean(request.buildId!)
    const blocked = input("console.log('MUST_NOT_VALIDATE')")
    const output: string[] = []
    blocked.onOutput = text => { output.push(text) }
    blocked.onStage = async (operation, state) => { if(operation === 'validation' && state === 'started') throw new Error('Lost claim') }
    await expect(runSandbox(blocked)).rejects.toBeInstanceOf(SandboxProgressError)
    expect(output.join('')).not.toContain('MUST_NOT_VALIDATE')
    await assertClean(blocked.buildId!)
  }, 30000)

})
