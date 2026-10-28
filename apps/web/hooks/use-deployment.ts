'use client'
// Publishing uses a saved request identity; reconnecting status never submits another deployment.
import { useCallback, useEffect, useRef, useState } from 'react'
import { readPublishingKey, persistPublishingKey, PUBLISHING_STORAGE_MESSAGE } from '@/lib/deployments/publishing-key'
import { apiFetch } from '@/lib/api'
const DEPLOYMENT_REQUEST_TIMEOUT_MS = 10_000
const POLL_MS = 2000
const TERMINAL = new Set(['success', 'failed', 'interrupted', 'cancelled'])
import { parseDeployment, type Deployment } from "@/lib/deployments/contracts"
interface State { buildId: string | undefined; enabled: boolean; loading: boolean; deployment: Deployment | null; error: string | null }
async function json(path: `/api/${string}`, signal: AbortSignal, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await apiFetch(path, { ...init, cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(DEPLOYMENT_REQUEST_TIMEOUT_MS)]) })
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object') throw new Error('Invalid publishing response.')
  if (!response.ok) throw new Error('error' in data && typeof data.error === 'string' ? data.error : 'Publishing request failed.')
  return data as Record<string, unknown>
}

/** Observes one selected revision and preserves admission identity across uncertain acknowledgements. */
export function useDeployment(projectId: string, buildId: string | undefined): { state: State; publish: () => Promise<void>; cancelQueued: () => Promise<void> } {
  const [state, setState] = useState<State>({ buildId, enabled: false, loading: true, deployment: null, error: null })
  const controller = useRef<AbortController | null>(null)
  const latest = useRef(state); latest.current = state
  const acknowledged = useRef<string | null>(null)
  const requestKey = useRef<string | null>(null)
  const storageReady = useRef(true)
  const submitting = useRef(false)
  const refresh = useRef<() => Promise<void>>(async () => {})
  const storageKey = `wrenly:publishing:${projectId}:${buildId}`
  useEffect(() => {
    const active = new AbortController(); controller.current = active; requestKey.current = null; acknowledged.current = null; submitting.current = false
    setState({ buildId, enabled: false, loading: true, deployment: null, error: null })
    if (!buildId) { setState({ buildId, enabled: false, loading: false, deployment: null, error: null }); return () => active.abort() }
    try { requestKey.current = readPublishingKey(localStorage, storageKey); storageReady.current = true } catch { storageReady.current = false }
    let timer: ReturnType<typeof setTimeout> | undefined
    let polling = false
    const poll = async (): Promise<void> => {
      if (active.signal.aborted || polling) return
      polling = true; if (timer) clearTimeout(timer)
      try {
        const data = await json(`/api/projects/${projectId}/deploy?buildId=${buildId}`, active.signal)
        if (typeof data.enabled !== 'boolean') throw new Error('Publishing configuration could not be read.')
        const deployment = parseDeployment(data.deployment, buildId)
        if (!active.signal.aborted && deployment && TERMINAL.has(deployment.status) && deployment.id === acknowledged.current) {
          requestKey.current = null; try { localStorage.removeItem(storageKey) } catch {}
        }
        if (!active.signal.aborted) setState({ buildId, enabled: data.enabled === true, loading: false, deployment, error: storageReady.current ? null : PUBLISHING_STORAGE_MESSAGE })
      } catch (error) {
        if (!active.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Publishing status unavailable.' }))
      } finally {
        polling = false
        if (!active.signal.aborted) timer = setTimeout(() => { void poll() }, POLL_MS)
      }
    }
    refresh.current = poll; void poll()
    return () => { active.abort(); if (timer) clearTimeout(timer) }
  }, [projectId, buildId, storageKey])
  const publish = useCallback(async (): Promise<void> => {
    const active = controller.current
    if (!buildId || !active || active.signal.aborted || submitting.current || latest.current.buildId !== buildId) return
    const status = latest.current.deployment?.status
    if (status && (!TERMINAL.has(status) || status === 'interrupted')) return
    if (!storageReady.current) { setState(previous => ({ ...previous, error: PUBLISHING_STORAGE_MESSAGE })); return }
    submitting.current = true
    // A known terminal request permits a fresh explicit publish. An uncertain POST
    // retains its original identity, including when its response never arrived.
    const key = requestKey.current ?? crypto.randomUUID(); requestKey.current = key
    try { persistPublishingKey(localStorage, storageKey, key) } catch {
      storageReady.current = false
      submitting.current = false
      setState(previous => ({ ...previous, loading: false, error: PUBLISHING_STORAGE_MESSAGE }))
      return
    }
    setState(previous => ({ ...previous, loading: true, error: null }))
    try {
      const response = await json(`/api/projects/${projectId}/deploy`, active.signal, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ buildId }) })
      if (typeof response.deploymentId !== 'string' || !response.deploymentId) throw new Error('Publishing acknowledgement is unavailable. Retry this request.')
      if (!active.signal.aborted) {
        acknowledged.current = response.deploymentId
        setState(previous => ({ ...previous, deployment: { id: response.deploymentId as string, buildId, status: 'queued', url: null, errorCode: null }, loading: false }))
        await refresh.current()
      }
    } catch (error) {
      if (!active.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Publishing acknowledgement is unavailable. Retry this request.' }))
    } finally { if (!active.signal.aborted) submitting.current = false }
  }, [projectId, buildId, storageKey])
  const cancelQueued = useCallback(async (): Promise<void> => {
    const active = controller.current; const deployment = latest.current.deployment
    if (!active || active.signal.aborted || !deployment || deployment.buildId !== buildId || deployment.status !== 'queued') return
    try {
      await json(`/api/projects/${projectId}/deployments/${deployment.id}/cancel`, active.signal, { method: 'POST' })
      if (!active.signal.aborted) await refresh.current()
    } catch (error) {
      if (!active.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Cancellation could not be confirmed.' }))
    }
  }, [projectId, buildId])
  return { state: state.buildId === buildId ? state : { buildId, enabled: false, loading: true, deployment: null, error: null }, publish, cancelQueued }
}
