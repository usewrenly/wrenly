'use client'
// Observes persisted build events. Closing this subscription does not own or cancel
// server execution; reconnecting restores the saved build and its event history.

import { apiFetch } from '@/lib/api'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BuildAcceptanceUnknownError, followDurableBuild, queuedBuildMessage, submitDurableBuild } from '@/lib/builds/durable-build-client'

import { INITIAL_BUILD_STATE, hydrateBuildState, reduceBuildEvent } from '@/lib/builds/build-state'
import type { BuildStreamState, PersistedBuildState } from '@/lib/builds/build-state'
export type { BuildPhase, BuildStreamState, FileTree } from '@/lib/builds/build-state'

export interface StartOptions {
  /** Stable handoff key survives development effect replays and navigation retries. */
  idempotencyKey?: string
  prompt?: string
  stack?: string
  model?: string
  /** Provider id the model belongs to — resolved server-side (never a key). */
  provider?: string
  previousBuildId?: string
  retryBuildId?: string
}

interface BuildStreamControls {
  state: BuildStreamState
  busy: boolean
  start: (options: StartOptions) => Promise<void>
  reset: () => void
  hydrate: (build: PersistedBuildState) => void
}

export function useBuildStream(projectId: string): BuildStreamControls {
  const [state, setState] = useState<BuildStreamState>(INITIAL_BUILD_STATE)
  const busyRef = useRef(false)
  const observer = useRef<AbortController | null>(null)
  const busy = !['idle', 'success', 'failed'].includes(state.phase.name)

  useEffect(() => {
    setState(INITIAL_BUILD_STATE)
    return () => { observer.current?.abort(); observer.current = null; busyRef.current = false }
  }, [projectId])

  const observe = useCallback(async (buildId: string, controller: AbortController): Promise<void> => {
    try {
      await followDurableBuild(buildId, {
        fetch: apiFetch, signal: controller.signal,
        snapshot: value => {
          if (observer.current !== controller) return
          setState(previous => {
            const restored = hydrateBuildState(value.build)
            if (value.outcome === 'queued' && restored.phase.name === 'pending') restored.phase.message = queuedBuildMessage(value.queue)
            return { ...restored, streamed: true, connection: previous.connection }
          })
        },
        event: event => {
          reduceBuildEvent(INITIAL_BUILD_STATE, event)
          if (observer.current === controller) setState(previous => reduceBuildEvent(previous, event))
        },
        connection: connection => {
          if (observer.current === controller) setState(previous => ({ ...previous, connection }))
        },
      })
    } catch (error) {
      if (!controller.signal.aborted && observer.current === controller)
        setState(previous => ({ ...previous, phase: { name: 'failed',
          attempt: 'attempt' in previous.phase ? previous.phase.attempt : 0,
          error: error instanceof Error ? error.message : 'Progress is unavailable. Reload history before retrying.', outcomeUnknown: true } }))
    } finally {
      if (observer.current === controller) busyRef.current = false
    }
  }, [])

  const hydrate = useCallback((build: PersistedBuildState): void => {
    observer.current?.abort()
    const controller = new AbortController()
    observer.current = controller
    setState(hydrateBuildState(build))
    busyRef.current = !['success', 'failed'].includes(build.status)
    if (build.id && busyRef.current) void observe(build.id, controller)
  }, [observe])

  const start = useCallback(async (options: StartOptions): Promise<void> => {
    if (busyRef.current) return
    observer.current?.abort()
    const controller = new AbortController()
    observer.current = controller
    busyRef.current = true
    setState({ phase: { name: 'pending', message: 'Submitting build…', attempt: 0 }, files: null, logs: [], streamed: true })
    try {
      const { idempotencyKey, ...request } = options
      const buildId = await submitDurableBuild({ projectId, ...request }, idempotencyKey ?? crypto.randomUUID(), apiFetch, controller.signal)
      if (observer.current !== controller || controller.signal.aborted) return
      setState(previous => ({ ...previous, buildId }))
      await observe(buildId, controller)
    } catch (error) {
      if (!controller.signal.aborted && observer.current === controller)
        setState(previous => ({ ...previous, phase: { name: 'failed', attempt: 0,
          error: error instanceof Error ? error.message : 'Build request was not accepted.', outcomeUnknown: error instanceof BuildAcceptanceUnknownError } }))
    } finally {
      if (observer.current === controller) busyRef.current = false
    }
  }, [projectId, observe])

  const reset = useCallback((): void => {
    observer.current?.abort(); observer.current = null; busyRef.current = false
    setState(INITIAL_BUILD_STATE)
  }, [])
  return { state, busy, start, reset, hydrate }
}
