// Invitation links and credentials stay out of browser storage.
import { apiFetch } from '../api'

const INVITATION_REQUEST_TIMEOUT_MS = 15_000
class InvitationResponseError extends Error {}

/** Keeps safe API errors distinct from an unconfirmed network or malformed-response failure. */
export async function invitationRequest(
  path: `/api/${string}`,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const response = await apiFetch(path, {
      cache: 'no-store',
      ...(body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(INVITATION_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(INVITATION_REQUEST_TIMEOUT_MS),
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      throw new InvitationResponseError(
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error : 'The invitation request could not be completed.',
      )
    }
    return value
  } catch (error) {
    if (error instanceof InvitationResponseError) throw error
    throw new Error('The request could not be confirmed. Refresh saved invitations or member access before retrying.')
  }
}
