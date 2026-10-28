// Manages bounded preview tasks while renewing ownership and watching runtime health.
// Lease loss stops local work; recovery waits for the old executor before cleanup or new claims.
import { PreviewClaimLostError, type PreviewClaim } from '../persistence/preview-store'
import { logger } from '../../../lib/logger'

const MONITOR_INTERVAL_MS = 5000
const POLL_INTERVAL_MS = 1000
const MAX_MANAGED_PREVIEWS = 2
export interface PreviewExecutionClaim extends PreviewClaim { files: Array<{ path: string; content: string }> }
export interface PreviewWorkerDependencies<Runtime> {
  claim: () => Promise<PreviewExecutionClaim | null>
  renew: (claim: PreviewClaim) => Promise<void>
  prepare: (claim: PreviewExecutionClaim, signal: AbortSignal) => Promise<Runtime>
  ready: (claim: PreviewClaim) => Promise<void>
  check: (runtime: Runtime) => Promise<void>
  fail: (claim: PreviewClaim) => Promise<void>
  interrupt: (claim: PreviewClaim) => Promise<void>
  cleanup: (claim: PreviewClaim) => Promise<void>
  reconcile: (quiesce: (claim: PreviewClaim) => Promise<void>) => Promise<PreviewClaim | null>
  assertExternalQuiescent: (claim: PreviewClaim) => Promise<void>
}
export interface PreviewWorkerTiming { monitorIntervalMs: number; pollIntervalMs: number }
interface Task { controller: AbortController; done: Promise<void> }
function wait(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
}
function logFailure(operation: string, error: unknown, claim?: PreviewClaim): void {
  logger.error('Preview worker operation failed', { operation, previewId: claim?.previewId,
    errorName: error instanceof Error ? error.name : 'UnknownError' })
}

async function manage<Runtime>(dependencies: PreviewWorkerDependencies<Runtime>, claim: PreviewExecutionClaim,
  controller: AbortController, shutdown: AbortSignal, intervalMs: number): Promise<void> {
  let runtime: Runtime | undefined
  let ownershipLost = false
  let runtimeFailed = false
  let monitorInFlight: Promise<void> | undefined
  const monitor = async (): Promise<void> => {
    try {
      await dependencies.renew(claim)
    } catch (error) {
      ownershipLost = true; controller.abort()
      if (error instanceof PreviewClaimLostError) logger.info('Preview management lease ended', { previewId: claim.previewId })
      else logFailure('renew', error, claim)
      return
    }
    if (runtime !== undefined && !controller.signal.aborted) {
      try { await dependencies.check(runtime) }
      catch (error) { runtimeFailed = true; controller.abort(); logFailure('runtime liveness', error, claim) }
    }
  }
  const check = (): Promise<void> => {
    if (!monitorInFlight) monitorInFlight = monitor().finally(() => { monitorInFlight = undefined })
    return monitorInFlight
  }
  const timer = setInterval(() => { if (!controller.signal.aborted) void check() }, intervalMs)
  try {
    await check()
    if (controller.signal.aborted || shutdown.aborted) return
    runtime = await dependencies.prepare(claim, controller.signal)
    if (controller.signal.aborted || shutdown.aborted) return
    await check()
    if (controller.signal.aborted || shutdown.aborted) return
    await dependencies.ready(claim)
    logger.info('Preview runtime ready', { previewId: claim.previewId, buildId: claim.buildId })
    await new Promise<void>(resolve => {
      if (controller.signal.aborted) { resolve(); return }
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  } catch (error) {
    runtimeFailed = !controller.signal.aborted
    if (!controller.signal.aborted && !(error instanceof PreviewClaimLostError)) logFailure('preparation or readiness', error, claim)
  } finally {
    clearInterval(timer)
    await monitorInFlight
    // Preparation has settled before these writes/cleanup; reconciliation never waits on us under a row lock.
    try {
      if (!ownershipLost) {
        if (shutdown.aborted) await dependencies.interrupt(claim)
        else if (runtimeFailed) await dependencies.fail(claim)
      }
    } catch (error) { if (!(error instanceof PreviewClaimLostError)) logFailure('terminal state', error, claim) }
    await dependencies.cleanup(claim)
  }
}

/** Explicitly runs bounded management; callers must await shutdown and supply trusted external recovery proof. */
export async function runPreviewWorker<Runtime>(dependencies: PreviewWorkerDependencies<Runtime>, shutdown: AbortSignal,
  timing: PreviewWorkerTiming = { monitorIntervalMs: MONITOR_INTERVAL_MS, pollIntervalMs: POLL_INTERVAL_MS }): Promise<void> {
  if (![timing.monitorIntervalMs, timing.pollIntervalMs].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Preview worker timing must be positive integers.')
  if (shutdown.aborted) return
  const tasks = new Map<string, Task>()
  const quiescent = new Set<string>()
  const cleanupUnconfirmed = new Set<string>()
  const key = (claim: PreviewClaim): string => `${claim.previewId}:${claim.token}`
  const abortAll = (): void => { for (const task of tasks.values()) task.controller.abort() }
  shutdown.addEventListener('abort', abortAll, { once: true })
  const quiesce = async (claim: PreviewClaim): Promise<void> => {
    const task = tasks.get(key(claim))
    if (task) { task.controller.abort(); await task.done; return }
    if (!quiescent.has(key(claim))) await dependencies.assertExternalQuiescent(claim)
  }
  const settleShutdown = async (): Promise<void> => {
    try {
      while (true) {
        const recovered = await dependencies.reconcile(quiesce)
        if (!recovered) break
        cleanupUnconfirmed.delete(key(recovered))
      }
      if (cleanupUnconfirmed.size) throw new Error('Preview resource cleanup remains unconfirmed.')
    } catch (error) {
      logFailure('shutdown recovery', error)
      throw new Error('Preview worker shutdown could not confirm resource cleanup.', { cause: error })
    }
  }
  try {
    while (!shutdown.aborted) {
      try {
        const recovered = await dependencies.reconcile(quiesce)
        if (recovered) { quiescent.delete(key(recovered)); cleanupUnconfirmed.delete(key(recovered)); continue }
        if (!shutdown.aborted && tasks.size < MAX_MANAGED_PREVIEWS) {
          const claim = await dependencies.claim()
          if (claim) {
            const controller = new AbortController()
            if (shutdown.aborted) controller.abort()
            // Defer management until its task is registered, including synchronously resolved fake adapters.
            const done = Promise.resolve().then(() => manage(dependencies, claim, controller, shutdown, timing.monitorIntervalMs))
              .catch((error: unknown) => { cleanupUnconfirmed.add(key(claim)); logFailure('task cleanup', error, claim) })
              .finally(() => { quiescent.add(key(claim)); tasks.delete(key(claim)) })
            tasks.set(key(claim), { controller, done })
          }
        }
      } catch (error) { logFailure('scheduling or recovery', error) }
      await wait(shutdown, timing.pollIntervalMs)
    }
  } finally {
    shutdown.removeEventListener('abort', abortAll)
    abortAll()
    await Promise.all([...tasks.values()].map(task => task.done))
    // Reconcile only tasks we can prove quiescent. Unknown prior executors remain reserved on rejection.
    await settleShutdown()
  }
}
