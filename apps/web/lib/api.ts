// COMPONENT: Browser API transport
// PURPOSE: Keep Wrenly requests on the web origin while the server proxies /api.
// INPUTS: API path and standard fetch options.
// OUTPUTS: The original JSON or streaming Response.
// STEPS: Forward the request with session credentials; let callers read the body.
// EDGE CASES: SSE stays unbuffered because this helper never consumes the response.
// ERROR STATES: Callers handle HTTP errors and rejected connections in their own UI.

/** Sends browser requests through the shared API proxy, including auth and SSE. */
export function apiFetch(path: `/api/${string}`, options: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...options, credentials: 'include' })
}
