// Holds a kernel lock for one preview claim so recovery cannot overlap its original executor.
// Parent input closure releases the lock after a crash; lock files remain stable for other processes.
import { mkdir, lstat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { z } from 'zod'
import type { PreviewClaim } from '../persistence/preview-store'

const DIRECTORY = join(tmpdir(), 'wrenly-preview-locks')
const UUID = z.string().uuid()
const LOCK_HANDSHAKE_TIMEOUT_MS = 2000
export interface PreviewExecutorLock { assertHeld: () => void; release: () => Promise<void> }

/** Kernel lock held by an EOF-bound trusted process. Lock inodes are never unlinked while other APIs might wait. */
export async function acquirePreviewExecutorLock(claim: PreviewClaim): Promise<PreviewExecutorLock> {
  if (![claim.previewId, claim.projectId, claim.buildId, claim.token].every(value => UUID.safeParse(value).success))
    throw new Error('Invalid preview executor identity.')
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 })
  const info = await lstat(DIRECTORY)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077))
    throw new Error('Preview lock directory must be private and owned by the API user.')
  const path = join(DIRECTORY, `${claim.previewId}-${claim.token}.lock`)
  try {
    const existing = await lstat(path)
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()) throw new Error('Unsafe preview lock file.')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const child = Bun.spawn(['flock', '--nonblock', path, 'sh', '-c', "printf 'locked\\n'; cat >/dev/null"],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } })
  const reader = child.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error('Preview lock handshake timed out.')) }, LOCK_HANDSHAKE_TIMEOUT_MS)

    })])
    if (first.done || new TextDecoder().decode(first.value) !== 'locked\n') throw new Error('Previous preview executor is still active; recovery retains capacity.')
  } catch (error) { child.stdin.end(); await child.exited; throw error }
  finally { if (timer) clearTimeout(timer); reader.releaseLock() }
  let released = false
  return { assertHeld: () => { if (released || child.exitCode !== null) throw new Error('Preview executor lock is no longer held.') }, release: async () => {
    if (released) return
    released = true
    child.stdin.end()
    if (await child.exited !== 0) throw new Error('Preview executor lock did not close cleanly.')
  } }
}
