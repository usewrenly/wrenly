import { expect, test } from 'bun:test'
import { runPreviewWorker, type PreviewExecutionClaim, type PreviewWorkerDependencies } from '../../execution/preview-worker'

const timing = { monitorIntervalMs: 5, pollIntervalMs: 5 }
const claim: PreviewExecutionClaim = { previewId: 'preview', buildId: 'build', projectId: 'project', token: 'token', files: [] }
function fixture(): { dependencies: PreviewWorkerDependencies<string>; calls: string[]; shutdown: AbortController } {
  let claimed = false
  const calls: string[] = []
  const shutdown = new AbortController()
  const dependencies: PreviewWorkerDependencies<string> = {
    claim: async () => { if (claimed) return null; claimed = true; calls.push('claim'); return claim },
    renew: async () => { calls.push('renew') },
    prepare: async () => { calls.push('prepare'); return 'runtime' },
    ready: async () => { calls.push('ready') },
    check: async () => { calls.push('check') },
    fail: async () => { calls.push('fail') },
    interrupt: async () => { calls.push('interrupt') },
    cleanup: async () => { calls.push('cleanup') },
    reconcile: async () => null,
    assertExternalQuiescent: async () => { throw new Error('Unverified previous executor') },
  }
  return { dependencies, calls, shutdown }
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Worker fixture timed out'); await Bun.sleep(2) }
}
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}
test('ready runtime stays managed and renews until shutdown, then interrupts and cleans', async () => {
  const f = fixture()
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  try { await until(() => f.calls.filter(call => call === 'check').length >= 2); expect(f.calls).not.toContain('cleanup') }
  finally { f.shutdown.abort(); await done }
  expect(f.calls.indexOf('interrupt')).toBeLessThan(f.calls.indexOf('cleanup'))
  expect(f.calls.filter(call => call === 'prepare')).toHaveLength(1)
})
test('lease loss aborts preparation and rejects late success without terminal writes', async () => {
  const f = fixture()
  let renewals = 0
  f.dependencies.renew = async () => { if (++renewals > 1) throw new Error('Lost lease') }
  f.dependencies.prepare = async (_claim, signal) => { await aborted(signal).catch(() => {}); return 'late runtime' }
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  try { await until(() => f.calls.includes('cleanup')); expect(f.calls).not.toContain('ready'); expect(f.calls).not.toContain('fail') }
  finally { f.shutdown.abort(); await done }
})
test('runtime death fails the preview and cleans it after preparation settles', async () => {
  const f = fixture()
  f.dependencies.check = async () => { if (f.calls.includes('ready')) throw new Error('Runtime exited') }
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  try { await until(() => f.calls.includes('cleanup')); expect(f.calls.indexOf('fail')).toBeLessThan(f.calls.indexOf('cleanup')) }
  finally { f.shutdown.abort(); await done }
})
test('preparation failure saves safe failed state before cleanup', async () => {
  const f = fixture()
  f.dependencies.prepare = async () => { throw new Error('Controlled adapter failure') }
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  try { await until(() => f.calls.includes('cleanup')); expect(f.calls.indexOf('fail')).toBeLessThan(f.calls.indexOf('cleanup')) }
  finally { f.shutdown.abort(); await done }
})
test('claim racing shutdown never prepares or publishes ready', async () => {
  const f = fixture()
  f.dependencies.claim = async () => { f.shutdown.abort(); return claim }
  await runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  expect(f.calls).not.toContain('prepare'); expect(f.calls).not.toContain('ready')
  expect(f.calls).toContain('interrupt'); expect(f.calls).toContain('cleanup')
})
test('slow renewals are serialized during preparation and retained runtime management', async () => {
  const f = fixture()
  let active = 0; let maximum = 0
  f.dependencies.renew = async () => { active++; maximum = Math.max(active, maximum); await Bun.sleep(15); active-- }
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  try { await until(() => f.calls.includes('ready')) } finally { f.shutdown.abort(); await done }
  expect(maximum).toBe(1)
})
test('bounds retained management to two tasks even if a faulty claim adapter offers more', async () => {
  const f = fixture()
  let claims = 0
  f.dependencies.claim = async () => ({ ...claim, previewId: `preview-${++claims}` })
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  try { await until(() => f.calls.filter(call => call === 'ready').length === 2); await Bun.sleep(20); expect(claims).toBe(2) }
  finally { f.shutdown.abort(); await done }
})
test('unverified external executor blocks recovery and new claims', async () => {
  const f = fixture()
  f.dependencies.reconcile = async quiesce => { f.calls.push('reconcile'); await quiesce(claim); return claim }
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  void done.catch(() => {})
  await until(() => f.calls.includes('reconcile'))
  f.shutdown.abort()
  await expect(done).rejects.toThrow('could not confirm')
  expect(f.calls).not.toContain('claim'); expect(f.calls).not.toContain('cleanup')
})
test('cleanup failure is surfaced on shutdown instead of claiming clean termination', async () => {
  const f = fixture()
  f.dependencies.cleanup = async () => { throw new Error('Cleanup unconfirmed') }
  const done = runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  void done.catch(() => {})
  await until(() => f.calls.includes('ready'))
  f.shutdown.abort()
  await expect(done).rejects.toThrow('could not confirm')
})

test('already stopped worker performs no recovery, claim or resource work', async () => {
  const f = fixture()
  f.shutdown.abort()
  f.dependencies.reconcile = async () => { throw new Error('Must not recover') }
  await runPreviewWorker(f.dependencies, f.shutdown.signal, timing)
  expect(f.calls).toEqual([])
})
