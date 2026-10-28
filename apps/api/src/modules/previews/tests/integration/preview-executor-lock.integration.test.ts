import { describe, expect, test } from 'bun:test'
import { acquirePreviewExecutorLock } from '../../execution/preview-executor-lock'
const integration = process.env.WRENLY_TEST_MCP === 'true' ? describe : describe.skip
integration('preview executor lock subprocess', () => {
  test('held claim excludes recovery, release is retryable and a different claim stays independent', async () => {
    const claim = { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), token: crypto.randomUUID() }
    const held = await acquirePreviewExecutorLock(claim)
    try {
      held.assertHeld()
      await expect(acquirePreviewExecutorLock(claim)).rejects.toThrow('still active')
      const other = await acquirePreviewExecutorLock({ ...claim, token: crypto.randomUUID() }); await other.release()
    } finally { await held.release(); await held.release() }
    expect(() => held.assertHeld()).toThrow('no longer held')
    const recovered = await acquirePreviewExecutorLock(claim); await recovered.release()
  })
  test('abrupt API parent exit closes stdin and releases its claim lock', async () => {
    const claim = { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), token: crypto.randomUUID() }
    const script = `import {acquirePreviewExecutorLock} from ${JSON.stringify(import.meta.dir + '/../../execution/preview-executor-lock.ts')};await acquirePreviewExecutorLock(${JSON.stringify(claim)});process.stdout.write('ready\\n');setInterval(()=>{},1000);`
    const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'ignore' })
    const reader = child.stdout.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready\n')
      await expect(acquirePreviewExecutorLock(claim)).rejects.toThrow('still active')
      child.kill('SIGSTOP')
      await expect(acquirePreviewExecutorLock(claim)).rejects.toThrow('still active')
      child.kill('SIGCONT')
      child.kill('SIGKILL'); await child.exited
      let recovered: Awaited<ReturnType<typeof acquirePreviewExecutorLock>> | undefined
      for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
        try { recovered = await acquirePreviewExecutorLock(claim) } catch { await Bun.sleep(25) }
      }
      expect(recovered).toBeDefined(); await recovered?.release()
    } finally { reader.releaseLock(); child.kill(); await child.exited }
  }, 5000)
})
