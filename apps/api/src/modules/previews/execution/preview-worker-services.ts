// Connects durable preview state to Docker adapters without giving browser reads execution ownership.
// Persist progress under the current claim and retain uncertain cleanup for explicit recovery.
import { createHash } from 'crypto'
import type { db } from '@wrenly/db'
import { previews, previewQueue, previewRequests } from '../../../../../../packages/db/src/schema'
import { startPreviewRuntime, cleanupPreviewRuntime, assertPreviewRuntimeRunning, readPreviewRuntimeLogs,
  type PreviewRuntimeInput, type PreviewRuntimeResult } from '@wrenly/sandbox'
import { claimNextPreview, renewPreviewLease, updatePreviewProgress, failPreview, interruptPreview,
  reconcilePreview, getPreviewRecoveryCandidate, assertPreviewClaim, type PreviewClaim } from '../persistence/preview-store'
import type { PreviewWorkerDependencies } from './preview-worker'
import { createBuildLogBatcher } from '../../builds/http/build-log-batcher'

const MAX_SEEN_RUNTIME_LINES = 512

export interface PreviewRuntimeAdapters {
  start: typeof startPreviewRuntime
  cleanup: (claim: PreviewClaim) => Promise<void>
  check: (claim: PreviewClaim, runtime: PreviewRuntimeResult) => Promise<void>
  logs?: (claim: PreviewClaim, runtime: PreviewRuntimeResult) => Promise<string>
  assertExecutionLock?: (claim: PreviewClaim) => void
  assertExternalQuiescent?: (claim: PreviewClaim) => Promise<void>
}
export interface PreviewWorkerConfiguration {
  ingressBundle: Uint8Array
  ingressFor: (claim: PreviewClaim) => PreviewRuntimeInput['ingress']
}
export interface ManagedPreviewRuntime { claim: PreviewClaim; runtime: PreviewRuntimeResult }
function identity(claim: PreviewClaim): PreviewRuntimeInput['identity'] {
  return { previewId: claim.previewId, projectId: claim.projectId, buildId: claim.buildId, claimToken: claim.token }
}

/** Fail loudly before explicit worker startup; does not apply migrations. */
export async function verifyPreviewWorkerSchema(database: typeof db): Promise<void> {
  try {
    await database.select().from(previews).limit(1)
    await database.select().from(previewQueue).limit(1)
    await database.select().from(previewRequests).limit(1)
  } catch { throw new Error('Preview persistence is unavailable. Run bun run db:migrate from packages/db (migration 0003) before enabling the preview worker.') }
}

/** Binds Docker and persistence without starting a worker. Unknown previous executors fail closed by default. */
export function createPreviewWorkerDependencies(database: typeof db, configuration: PreviewWorkerConfiguration,
  adapters: PreviewRuntimeAdapters = {
    start: startPreviewRuntime,
    cleanup: claim => cleanupPreviewRuntime(identity(claim)),
    check: (claim, runtime) => assertPreviewRuntimeRunning(identity(claim), runtime),
    logs: (claim, runtime) => readPreviewRuntimeLogs(identity(claim), runtime.resources.appContainerId),
  }): PreviewWorkerDependencies<ManagedPreviewRuntime> {
  const logSeen = new Map<string, Set<string>>()
  return {
    claim: () => claimNextPreview(database),
    renew: async claim => { adapters.assertExecutionLock?.(claim); await renewPreviewLease(database, claim); adapters.assertExecutionLock?.(claim) },
    prepare: async (claim, signal) => {
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const logs = createBuildLogBatcher(text => updatePreviewProgress(database, claim, { type: 'log', text: text + '\n' }), abort)
      try {
        const runtime = await adapters.start({ identity: identity(claim), stack: claim.stack, files: claim.files,
          ingressBundle: configuration.ingressBundle, ingress: configuration.ingressFor(claim), signal: controller.signal,
          onOutput: logs.write, beforeEffect: () => assertPreviewClaim(database, claim),
          onStarted: async (resources, preparation) => {
            await updatePreviewProgress(database, claim, { type: 'starting', resources: { ...resources, preparation } })
          } })
        await logs.drain()
        return { claim, runtime }
      } finally { signal.removeEventListener('abort', abort); await logs.drain() }
    },
    ready: claim => updatePreviewProgress(database, claim, { type: 'ready' }),
    check: async handle => {
      if (adapters.logs) {
        const seen = logSeen.get(handle.claim.previewId) ?? new Set<string>()
        logSeen.set(handle.claim.previewId, seen)
        let text: string
        try { text = await adapters.logs(handle.claim, handle.runtime) }
        catch { text = 'Preview runtime logs unavailable; its container may have exited or been removed.' }
        const fresh: string[] = []
        for (const line of text.split('\n').filter(Boolean)) {
          const hash = createHash('sha256').update(line).digest('hex')
          if (!seen.has(hash)) { fresh.push(line); seen.add(hash) }
        }
        while (seen.size > MAX_SEEN_RUNTIME_LINES) seen.delete(seen.values().next().value!)
        if (fresh.length) await updatePreviewProgress(database, handle.claim, { type: 'log', text: fresh.join('\n') + '\n' })
      }
      await adapters.check(handle.claim, handle.runtime)
    },
    fail: claim => failPreview(database, claim, 'Preview preparation or runtime failed. Review the saved preview diagnostics.'),
    interrupt: claim => interruptPreview(database, claim),
    cleanup: async claim => { logSeen.delete(claim.previewId); await adapters.cleanup(claim) },
    assertExternalQuiescent: async claim => {
      if (!adapters.assertExternalQuiescent) throw new Error('Previous preview executor quiescence is unverified; recovery retains its reservation.')
      await adapters.assertExternalQuiescent(claim)
    },
    reconcile: async quiesce => {
      const candidate = await getPreviewRecoveryCandidate(database)
      if (!candidate) return null
      // Never await the executor while holding the cleanup transaction's row lock.
      await quiesce(candidate)
      const cleaned = await reconcilePreview(database, async current => {
        if (current.token !== candidate.token || current.previewId !== candidate.previewId) throw new Error('Preview recovery identity changed.')
        await adapters.cleanup(current)
      }, candidate.previewId)
      return cleaned ? candidate : null
    },
  }
}
