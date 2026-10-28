// Submits a message while preserving its identity when the response is lost.
import type { ConversationFetch, ConversationRequest } from "./contracts"

// Retry only acknowledgement loss, not explicit rejection or a new conversation turn.
const SUBMISSION_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class ConversationAcceptanceUnknownError extends Error {
  constructor() { super('Message acceptance is unconfirmed. Check the saved request before sending another message.'); this.name = 'ConversationAcceptanceUnknownError' }
}

/** Retries acknowledgement with one frozen key; never silently admits a second turn. */
export async function submitConversationTurn(projectId: string, request: ConversationRequest, key: string, fetchApi: ConversationFetch, signal: AbortSignal): Promise<string> {
  // A lost response may follow a committed request: every retry must send identical text.
  const serializedRequest = JSON.stringify(request)
  for (let attempt = 0; attempt < SUBMISSION_ATTEMPTS; attempt++) {
    signal.throwIfAborted()
    let response: Response
    let value: unknown
    try {
      response = await fetchApi(`/api/projects/${projectId}/messages`, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: serializedRequest })
      value = await response.json()
    } catch {
      signal.throwIfAborted()
      if (attempt === SUBMISSION_ATTEMPTS - 1) throw new ConversationAcceptanceUnknownError()
      await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      continue
    }
    if (!response.ok) {
      if (response.status >= 500) throw new ConversationAcceptanceUnknownError()
      throw new Error(isRecord(value) && typeof value.error === 'string' ? value.error : `Message request failed (${response.status}).`)
    }
    if (!isRecord(value) || typeof value.turnId !== 'string' || !value.turnId) throw new ConversationAcceptanceUnknownError()
    return value.turnId
  }
  throw new ConversationAcceptanceUnknownError()
}
