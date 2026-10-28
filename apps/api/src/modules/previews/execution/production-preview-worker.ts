// Activates opt-in local preview execution after schema, host-isolation and kernel-lock checks.
// Only managed runtimes enter the gateway map; shutdown waits for execution and cleanup.
import { existsSync } from 'fs'
import { createHmac } from 'crypto'
import type { db } from '@wrenly/db'
import { startPreviewRuntime, cleanupPreviewRuntime, assertPreviewRuntimeRunning, readPreviewRuntimeLogs, verifyPreviewHost, type PreviewRuntimeInput } from '@wrenly/sandbox'
import { previewAccess } from '../../../../../../packages/db/src/schema'
import type { ApiEnvironment } from '../../../config/api-environment'
import { verifyPreviewWorkerSchema, createPreviewWorkerDependencies } from './preview-worker-services'
import { runPreviewWorker } from './preview-worker'
import { acquirePreviewExecutorLock, type PreviewExecutorLock } from './preview-executor-lock'
import { previewOrigin } from '../access/preview-access'
import { PREVIEW_COOKIE } from '../gateway/preview-gateway'
import type { PreviewClaim } from '../persistence/preview-store'

const DOCKER_SETTLE_MS = 10_000

export interface PreviewLifecycle {
  stop: () => Promise<void>
  runtime: (id: string) => { ingressUrl: string; capability: string } | null
}
function identity(claim: PreviewClaim): PreviewRuntimeInput['identity'] {
  return { previewId: claim.previewId, projectId: claim.projectId, buildId: claim.buildId, claimToken: claim.token }
}
/** Linux host process/local Docker only; no implicit activation or unsupported distributed lock fallback. */
export async function startProductionPreviewWorker(database: typeof db, environment: ApiEnvironment, ingressBundle: Uint8Array): Promise<PreviewLifecycle> {
  if (process.platform !== 'linux' || existsSync('/.dockerenv') || existsSync('/run/.containerenv') || process.env.container)
    throw new Error('Local previews currently require the API to run directly on a Linux Docker host with GNU flock.')
  await verifyPreviewWorkerSchema(database)
  try { await database.select({ id: previewAccess.id }).from(previewAccess).limit(1) }
  catch { throw new Error('Preview access persistence is unavailable. Apply migration 0004 with bun run db:migrate from packages/db.') }
  const probeLock = await acquirePreviewExecutorLock({ previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), token: crypto.randomUUID() })
  await probeLock.release()
  await verifyPreviewHost()
  const locks = new Map<string, PreviewExecutorLock>()
  const live = new Map<string, { ingressUrl: string; capability: string }>()
  const key = (claim: PreviewClaim): string => claim.previewId + ':' + claim.token
  const lock = async (claim: PreviewClaim): Promise<void> => { if (!locks.has(key(claim))) locks.set(key(claim), await acquirePreviewExecutorLock(claim)) }
  const capability = (claim: PreviewClaim): string => createHmac('sha256', environment.WRENLY_AUTH_SECRET).update('preview-ingress:' + key(claim)).digest('hex')
  const shutdown = new AbortController()
  const dependencies = createPreviewWorkerDependencies(database, { ingressBundle,
    ingressFor: claim => ({ previewOrigin: previewOrigin(environment.WRENLY_PREVIEW_BASE_URL, claim.previewId), controlOrigin: environment.WRENLY_WEB_URL,
      capability: capability(claim), blockedCookieNames: [PREVIEW_COOKIE, 'better-auth.session_token', '__Secure-better-auth.session_token', 'better-auth.session_data', '__Secure-better-auth.session_data', 'wrenly_session'] }) }, {
    start: async input => {
      const claim = { previewId: input.identity.previewId, projectId: input.identity.projectId, buildId: input.identity.buildId, token: input.identity.claimToken }
      await lock(claim)
      const result = await startPreviewRuntime({ ...input, beforeEffect: async () => {
        locks.get(key(claim))!.assertHeld(); await input.beforeEffect?.(); locks.get(key(claim))!.assertHeld()
      } })
      live.set(claim.previewId, { ingressUrl: result.ingressUrl, capability: capability(claim) })
      return result
    },
    assertExecutionLock: claim => { locks.get(key(claim))?.assertHeld() },
    check: async (claim, runtime) => { locks.get(key(claim))!.assertHeld(); await assertPreviewRuntimeRunning(identity(claim), runtime) },
    logs: (claim, runtime) => readPreviewRuntimeLogs(identity(claim), runtime.resources.appContainerId),
    cleanup: async claim => {
      live.delete(claim.previewId)
      await lock(claim)
      await cleanupPreviewRuntime(identity(claim))
      const held = locks.get(key(claim))
      await held?.release(); locks.delete(key(claim))
    },
    assertExternalQuiescent: async claim => {
      await lock(claim)
      // Hold the dead executor's lock through a client-request settle window; Docker removal acknowledgements are still required.
      await Bun.sleep(DOCKER_SETTLE_MS)
    },
  })
  const done = runPreviewWorker(dependencies, shutdown.signal)
  void done.catch(() => {})
  return { runtime: id => live.get(id) ?? null, stop: async () => { shutdown.abort(); await done } }
}
