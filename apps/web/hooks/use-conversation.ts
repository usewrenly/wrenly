'use client'
// COMPONENT: Reload-safe conversation state and admission acknowledgement
// Restores saved history and keeps uncertain submissions tied to their original key.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConversationAcceptanceUnknownError, submitConversationTurn } from '@/lib/conversations/client'
import { apiFetch } from '@/lib/api'
import { ACTIVE_TURN_STATUSES, parseConversationHistory, parseConversationRequest,
  type ConversationMessage, type ConversationTurn, type ConversationRequest } from '@/lib/conversations/contracts'

const POLL_INTERVAL_MS = 1000
const MAX_HISTORY_PAGES = 21
interface PendingRequest { key: string; request: ConversationRequest }
interface ConversationState {
  messages: ConversationMessage[]; turns: ConversationTurn[]; latest: ConversationTurn | null
  loading: boolean; error: string | null; submitting: boolean; unknown: boolean; invalidPending: boolean
  draft: { id: string; request: ConversationRequest } | null
}
const EMPTY: ConversationState = { messages: [], turns: [], latest: null, loading: true, error: null, submitting: false, unknown: false, invalidPending: false, draft: null }

export function useConversation(projectId: string): ConversationState & {
  busy: boolean; submit: (request: ConversationRequest) => Promise<boolean>; retry: (turn: ConversationTurn) => Promise<boolean>
  resume: (request: ConversationRequest, key: string) => Promise<boolean>
  dismissInvalidPending: () => void
  cancel: () => Promise<void>; reconnect: () => void; checkPending: () => Promise<boolean>
} {
  const [state, setState] = useState<ConversationState>(EMPTY)
  const [refresh, setRefresh] = useState(0)
  const current = useRef<AbortController | null>(null)
  const stateRef = useRef(state); stateRef.current = state
  const submitting = useRef(false)
  const pending = useRef<PendingRequest | null>(null)
  const previousProject = useRef<string | null>(null)
  const storageKey = `wrenly:conversation-pending:${projectId}`
  const reconnect = useCallback((): void => setRefresh(value => value + 1), [])

  const sendPending = useCallback(async (saved: PendingRequest): Promise<boolean> => {
    const controller = current.current
    if (!controller || controller.signal.aborted || submitting.current) return false
    submitting.current = true; pending.current = saved
    setState(previous => ({ ...previous, submitting: true, unknown: false, error: null }))
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(saved))
      const turnId = await submitConversationTurn(projectId, saved.request, saved.key, apiFetch, controller.signal)
      if (current.current !== controller || controller.signal.aborted) return false
      sessionStorage.removeItem(storageKey); pending.current = null
      setState(previous => ({ ...previous, error: null, unknown: false, latest: { id: turnId, status: 'queued',
        mode: saved.request.mode, baseBuildId: saved.request.baseBuildId, buildId: null, errorMessage: null,
        model: saved.request.model ?? '', provider: saved.request.provider ?? '',
        ...(saved.request.database ? { database: saved.request.database } : {}) } }))
      reconnect()
      return true
    } catch (error) {
      if (current.current !== controller || controller.signal.aborted) return false
      const unknown = error instanceof ConversationAcceptanceUnknownError
      if (!unknown) { sessionStorage.removeItem(storageKey); pending.current = null }
      setState(previous => ({ ...previous, unknown, error: error instanceof Error ? error.message : 'The message could not be submitted.',
        draft: unknown ? previous.draft : { id: saved.key, request: saved.request } }))
      return false
    } finally {
      if (current.current === controller) { submitting.current = false; setState(previous => ({ ...previous, submitting: false })) }
    }
  }, [projectId, storageKey, reconnect])

  useEffect(() => {
    const controller = new AbortController(); current.current = controller
    submitting.current = false
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = 0
    let latestId: string | null = null
    const changedProject = previousProject.current !== projectId
    previousProject.current = projectId
    if (changedProject) pending.current = null
    setState(previous => changedProject ? EMPTY : { ...previous, loading: true, error: previous.unknown ? previous.error : null })
    const load = async (): Promise<void> => {
      try {
        let page = 0
        let more = true
        while (more && !controller.signal.aborted) {
          if (++page > MAX_HISTORY_PAGES) throw new Error('Conversation history exceeds the supported page limit.')
          const queryCursor = cursor
          const response = await apiFetch(`/api/projects/${projectId}/messages?after=${cursor}&limit=100`, { signal: controller.signal })
          if (!response.ok) throw new Error(`Conversation history is unavailable (HTTP ${response.status}). Reconnect before sending another message.`)
          const history = parseConversationHistory(await response.json())
          if (current.current !== controller || controller.signal.aborted) return
          let next = cursor
          for (const message of history.messages) {
            if (message.sequence !== next + 1) throw new Error('Conversation message history has a gap. Reconnect to reload it.')
            next = message.sequence
          }
          if (history.nextCursor !== null && history.nextCursor !== next) throw new Error('Conversation page cursor is inconsistent.')
          setState(previous => {
            const messages = new Map(previous.messages.map(message => [message.id, message]))
            for (const message of history.messages) messages.set(message.id, message)
            const turns = new Map(previous.turns.map(turn => [turn.id, turn]))
            for (const turn of history.turns) turns.set(turn.id, turn)
            if (history.latestTurn) turns.set(history.latestTurn.id, history.latestTurn)
            return { ...previous, messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence), turns: [...turns.values()],
              latest: history.latestTurn, loading: false, error: previous.unknown ? previous.error : null }
          })
          cursor = next
          more = history.nextCursor !== null
          if (latestId && history.latestTurn?.id !== latestId && queryCursor > 0) { cursor = 0; more = true }
          latestId = history.latestTurn?.id ?? null
        }
      } catch (error) {
        if (!controller.signal.aborted && current.current === controller)
          setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Conversation history could not reconnect.' }))
      } finally {
        if (!stopped && !controller.signal.aborted) timer = setTimeout(() => { void load() }, POLL_INTERVAL_MS)
      }
    }
    void load()
    return () => { stopped = true; if (timer) clearTimeout(timer); controller.abort(); if (current.current === controller) current.current = null }
  }, [projectId, refresh])

  // Only admission acknowledgement is replayed, with the identical key and frozen settings.
  useEffect(() => {
    if (state.loading || state.error || state.submitting) return
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (!raw || pending.current) return
      const saved = JSON.parse(raw) as { key?: unknown; request?: unknown }
      if (typeof saved.key !== 'string') throw new Error('The saved message key is invalid.')
      const restored = { key: saved.key, request: parseConversationRequest(saved.request) }
      pending.current = restored
      void sendPending(restored)
    } catch (error) { setState(previous => ({ ...previous, unknown: true, invalidPending: true, error: error instanceof Error ? error.message : 'The pending message could not be restored.' })) }
  }, [state.loading, state.error, state.submitting, storageKey, sendPending])

  const submit = useCallback(async (request: ConversationRequest): Promise<boolean> => {
    if (stateRef.current.loading || stateRef.current.error || pending.current || submitting.current ||
      (stateRef.current.latest && ACTIVE_TURN_STATUSES.has(stateRef.current.latest.status))) return false
    return sendPending({ key: crypto.randomUUID(), request })
  }, [sendPending])
  const retry = useCallback(async (turn: ConversationTurn): Promise<boolean> => {
    const message = stateRef.current.messages.find(value => value.turnId === turn.id && value.role === 'user')
    if (!message || turn.buildId) return false
    return submit({ message: message.content, mode: turn.mode, baseBuildId: turn.baseBuildId, model: turn.model, provider: turn.provider, ...(turn.database ? { database: turn.database } : {}) })
  }, [submit])
  const cancel = useCallback(async (): Promise<void> => {
    const controller = current.current; const turn = stateRef.current.latest
    if (!controller || !turn) return
    try {
      const response = await apiFetch(`/api/conversation-turns/${turn.id}/cancel`, { method: 'POST', signal: controller.signal })
      if (!response.ok) throw new Error('Cancellation could not be confirmed. Reconnect to check saved state.')
      if (current.current === controller && !controller.signal.aborted) reconnect()
    } catch (error) {
      if (current.current === controller && !controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Cancellation is unavailable.' }))
    }
  }, [reconnect])
  const resume = useCallback(async (request: ConversationRequest, key: string): Promise<boolean> => {
    if (pending.current && pending.current.key !== key) return false
    return sendPending({ request, key })
  }, [sendPending])
  const dismissInvalidPending = useCallback((): void => {
    if (!stateRef.current.invalidPending) return
    try { sessionStorage.removeItem(storageKey) } catch { return }
    pending.current = null
    setState(previous => ({ ...previous, unknown: false, invalidPending: false, error: null }))
    reconnect()
  }, [storageKey, reconnect])
  const checkPending = useCallback(async (): Promise<boolean> => pending.current ? sendPending(pending.current) : false, [sendPending])
  return { ...state, busy: state.submitting || state.unknown || Boolean(state.latest && ACTIVE_TURN_STATUSES.has(state.latest.status)), submit, retry, resume, dismissInvalidPending, cancel, reconnect, checkPending }
}
