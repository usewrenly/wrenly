// COMPONENT: Durable build browser client
// PURPOSE: Reconnect to persisted work without starting another execution.
// INPUTS: One build ID, an authenticated fetch function and cancellation signal.
// OUTPUTS: Saved state and ordered progress callbacks, or an actionable error.
// STEPS: Load a snapshot/cursor pair, replay later events, reconnect on loss.
// EDGE CASES: Submission retries reuse one key so lost acknowledgements do not duplicate work.
// ERROR STATES: Reject invalid identity/sequence; never resubmit while reconnecting.
import { isGeneratedFiles, readBuildEvents, type BuildEvent } from './build-events'
import type { PersistedBuildState } from './build-state'

const MAX_SUBMISSION_ATTEMPTS = 3
const MAX_RECONNECT_ATTEMPTS = 8
const RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 5000
const TERMINAL = new Set(['success', 'failed', 'interrupted', 'cancelled'])
type FetchApi = (path: `/api/${string}`, options?: RequestInit) => Promise<Response>
export interface DurableSnapshot {
  build: PersistedBuildState & { id: string }
  outcome: string | null
  cursor: number
  queue?: { position: number; reason: 'waiting' | 'busy' | 'recovering' }
}

/** Validates public snapshots before editor hydration or cursor advancement. */
export function parseDurableSnapshot(value: unknown): DurableSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid build snapshot.')
  const snapshot = value as Record<string, unknown>
  const build = snapshot.build as Record<string, unknown> | null
  if (!build || typeof build !== 'object' || typeof build.id !== 'string' ||
    !['pending', 'generating', 'building', 'success', 'failed'].includes(String(build.status)) ||
    !Number.isSafeInteger(build.attemptCount) || Number(build.attemptCount) < 0 ||
    (build.files !== null && !isGeneratedFiles(build.files)) ||
    !['buildLog', 'errorMessage', 'deployedUrl'].every((key) => build[key] === null || typeof build[key] === 'string') ||
    (snapshot.outcome !== null && !['queued', 'running', ...TERMINAL].includes(String(snapshot.outcome))) ||
    !Number.isSafeInteger(snapshot.cursor) || Number(snapshot.cursor) < 0)
    throw new Error('Invalid build snapshot.')
  if (snapshot.queue !== undefined) {
    const queue = snapshot.queue as Record<string, unknown> | null
    if (!queue || typeof queue !== 'object' || !Number.isSafeInteger(queue.position) || Number(queue.position) < 1 || !['waiting', 'busy', 'recovering'].includes(String(queue.reason)))
      throw new Error('Invalid build queue state.')
  }
  return snapshot as unknown as DurableSnapshot
}

async function wait(signal: AbortSignal, milliseconds: number): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
      signal.addEventListener('abort', abort, { once: true })
    })
  } catch (error) { throw error instanceof Error ? error : new Error('Build observation stopped.') }
}

/** Observes one saved build; every reconnect starts from an atomic snapshot/cursor pair. */
export async function followDurableBuild(
  buildId: string,
  options: {
    fetch: FetchApi; signal: AbortSignal;
    snapshot: (value: DurableSnapshot) => void;
    event: (event: BuildEvent) => void;
    connection: (state: 'connecting' | 'connected' | 'reconnecting') => void;
  },
): Promise<void> {
  let failures = 0
  while (!options.signal.aborted) {
    try {
      options.connection(failures ? 'reconnecting' : 'connecting')
      const response = await options.fetch(`/api/builds/${buildId}`, { signal: options.signal })
      if (!response.ok) throw new Error(`Build state unavailable (${response.status}).`)
      const snapshot = parseDurableSnapshot(await response.json())
      if (snapshot.build.id !== buildId) throw new Error('Build identity mismatch.')
      options.signal.throwIfAborted()
      options.snapshot(snapshot)
      if (snapshot.outcome && TERMINAL.has(snapshot.outcome)) return
      if (!snapshot.outcome) throw new Error('This older build has no durable execution record. Check history before retrying.')
      const stream = await options.fetch(`/api/builds/${buildId}/events?after=${snapshot.cursor}`, { signal: options.signal })
      if (!stream.ok || !stream.body) throw new Error(`Build progress unavailable (${stream.status}).`)
      options.connection('connected')
      let cursor = snapshot.cursor
      await readBuildEvents(stream.body, (event) => {
        options.signal.throwIfAborted()
        const sequence = Number(event.id)
        if (!event.id || !Number.isSafeInteger(sequence) || sequence !== cursor + 1 || event.data.buildId !== buildId)
          throw new Error('Invalid build replay sequence.')
        options.event(event)
        cursor = sequence
      })
      return
    } catch (error) {
      if (options.signal.aborted) return
      if (++failures >= MAX_RECONNECT_ATTEMPTS)
        throw new Error('Progress could not reconnect. Reload history to check the saved build before retrying.', { cause: error })
      options.connection('reconnecting')
      await wait(options.signal, Math.min(RETRY_DELAY_MS * failures, MAX_RETRY_DELAY_MS))
    }
  }
}

export class BuildAcceptanceUnknownError extends Error {
  constructor() { super('Build acceptance is unconfirmed. Reload history before submitting again.'); this.name = 'BuildAcceptanceUnknownError' }
}

/** Repeats ambiguous acknowledgement with one key; never silently schedules another build. */
export async function submitDurableBuild(
  body: Record<string, unknown>, key: string, fetchApi: FetchApi, signal: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SUBMISSION_ATTEMPTS; attempt++) {
    let response: Response
    let result: unknown
    try {
      response = await fetchApi('/api/builds', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) })
      result = await response.json()
    } catch (error) {
      signal.throwIfAborted()
      if (attempt === MAX_SUBMISSION_ATTEMPTS - 1) throw new BuildAcceptanceUnknownError()
      await wait(signal, RETRY_DELAY_MS)
      continue
    }
    if (!response.ok) {
      const message = typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string'
        ? result.error : `Build request failed (${response.status}).`
      throw new Error(message)
    }
    if (typeof result !== 'object' || result === null || !('buildId' in result) || typeof result.buildId !== 'string')
      throw new BuildAcceptanceUnknownError()
    return result.buildId
  }
  throw new BuildAcceptanceUnknownError()
}


/** Explains admission waiting without implying that refreshing or signing out executes work. */
export function queuedBuildMessage(queue: DurableSnapshot['queue']): string {
  if (queue?.reason === 'recovering') return 'Queued — cleaning up an interrupted build before execution can start.'
  if (queue?.reason === 'busy') return `Queued — waiting for another build to finish. Queue position ${queue.position}.`
  return 'Build queued — waiting for the API worker.'
}
