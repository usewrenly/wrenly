'use client'
// Observes the selected revision; browser subscriptions never own runtime execution.
import { useCallback, useEffect, useRef, useState } from 'react'
import { parsePreviewAccessUrl } from '@/lib/previews/access-url'
import { apiFetch } from '@/lib/api'

import { parsePreview as preview, type LocalPreview } from "@/lib/previews/contracts"
interface PreviewState { buildId?: string; enabled: boolean; supported: boolean; preview: LocalPreview | null; activePreview: LocalPreview | null; url: string | null; error: string | null; loading: boolean }
const PREVIEW_REQUEST_TIMEOUT_MS = 10_000
const PREVIEW_POLL_MS = 1_500
const CLEANUP_CHECK_ATTEMPTS = 40
const CLEANUP_CHECK_DELAY_MS = 250

const EMPTY: PreviewState = { enabled: false, supported: false, preview: null, activePreview: null, url: null, error: null, loading: true }
async function json(path: `/api/${string}`, signal: AbortSignal, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await apiFetch(path, { ...init, cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS)]) })
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object') throw new Error('Invalid preview response.')
  if (!response.ok) throw new Error('error' in data && typeof data.error === 'string' ? data.error : 'Preview request failed.')
  return data as Record<string, unknown>
}
/** Observes one selected successful revision; late responses from a previous selection never frame another build. */
export function useLocalPreview(buildId: string | undefined, successful: boolean, authorizationRevision?: string | null): { state: PreviewState; start: () => Promise<void>; stop: () => Promise<void>; open: () => Promise<void>; reload: () => void } {
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [state, setState] = useState<PreviewState>(EMPTY)
  const current = useRef<AbortController | null>(null)
  const latest = useRef(state); latest.current = state
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    const controller = new AbortController(); current.current = controller
    setState({ ...EMPTY, buildId })
    if (!buildId || !successful) { setState({ ...EMPTY, buildId, loading: false }); return () => controller.abort() }
    let timer: ReturnType<typeof setTimeout> | undefined
    let framed: string | null = null
    let inFlight = false
    const poll = async (): Promise<void> => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      if (timer) clearTimeout(timer)
      try {
        const data = await json(`/api/builds/${buildId}/preview`, controller.signal)
        if (typeof data.enabled !== 'boolean' || typeof data.supported !== 'boolean') throw new Error('Preview configuration could not be read.')
        const enabled = data.enabled, supported = data.supported
        const selected = preview(data.preview); const active = preview(data.activePreview)
        if (controller.signal.aborted) return
        if (selected && selected.buildId !== buildId) throw new Error('Preview revision does not match the selected build.')
        setState(previous => ({ ...previous, enabled, supported, preview: selected, activePreview: active, loading: false, error: null,
          url: selected?.status === 'ready' && selected.id === previous.preview?.id ? previous.url : null }))
        if (selected?.status === 'ready' && framed !== selected.id) {
          const access = await json(`/api/previews/${selected.id}/access`, controller.signal, { method: 'POST' })
          const accessUrl = parsePreviewAccessUrl(access.url)
          if (!controller.signal.aborted) { framed = selected.id; setState(previous => ({ ...previous, url: accessUrl })) }
        }
      } catch (error) { if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Preview unavailable.' })) }
      finally { inFlight = false; if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, PREVIEW_POLL_MS) }
    }
    refresh.current = poll
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [buildId, successful, authorizationRevision, refreshVersion])
  const start = useCallback(async (): Promise<void> => {
    const controller = current.current
    if (!buildId || !controller || controller.signal.aborted) return
    setState(previous => ({ ...previous, loading: true, error: null }))
    try {
      const existing = latest.current.activePreview ?? latest.current.preview
      if (existing && (existing.buildId !== buildId || !['queued', 'preparing', 'starting', 'ready'].includes(existing.status))) {
        await json(`/api/previews/${existing.id}/stop`, controller.signal, { method: 'POST' })
        for (let attempt = 0; attempt < CLEANUP_CHECK_ATTEMPTS; attempt++) {
          const found = await json(`/api/builds/${buildId}/preview`, controller.signal)
          const active = preview(found.activePreview); const selected = preview(found.preview)
          if (!active && (!selected || !selected.cleanupPending)) break
          if (attempt === CLEANUP_CHECK_ATTEMPTS - 1) throw new Error('Preview cleanup is still pending. Check its diagnostics before restarting.')
          await new Promise(resolve => setTimeout(resolve, CLEANUP_CHECK_DELAY_MS))
        }
      }
      await json(`/api/builds/${buildId}/preview`, controller.signal, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } })
      if (!controller.signal.aborted) await refresh.current()
    } catch (error) { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Preview could not start.' })) }
    finally { if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false })) }
  }, [buildId])
  const stop = useCallback(async (): Promise<void> => {
    const controller = current.current; const selected = latest.current.preview
    if (!controller || !selected) return
    try { await json(`/api/previews/${selected.id}/stop`, controller.signal, { method: 'POST' }); if (!controller.signal.aborted) { setState(previous => ({ ...previous, url: null, preview: previous.preview ? { ...previous.preview, status: 'stopped', cleanupPending: true } : null })); await refresh.current() } }
    catch (error) { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Preview could not stop.' })) }
  }, [])
  const open = useCallback(async (): Promise<void> => {
    const selected = latest.current.preview; const controller = current.current
    if (!selected || selected.status !== 'ready' || !controller) return
    const windowRef = window.open('about:blank', '_blank'); if (windowRef) windowRef.opener = null
    try {
      const data = await json(`/api/previews/${selected.id}/access`, controller.signal, { method: 'POST' })
      if (controller.signal.aborted) { windowRef?.close(); return }
      const accessUrl = parsePreviewAccessUrl(data.url)
      if (windowRef) windowRef.location.replace(accessUrl)
      else throw new Error('Allow popups for Wrenly, then open the preview again.')
    } catch (error) { windowRef?.close(); if (!controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Preview could not open.' })) }
  }, [])
  const reload = useCallback((): void => setRefreshVersion(value => value + 1), [])
  return { reload, state: state.buildId === buildId && successful ? state : { ...EMPTY, buildId, loading: Boolean(buildId && successful) }, start, stop, open }
}
