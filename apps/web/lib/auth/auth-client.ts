//
// Better Auth client — used in the browser to check session state,
// sign in, and sign out. Talks to apps/api's /api/auth/* routes.

import { createAuthClient } from 'better-auth/react'

import { readWebOrigin } from '../configuration/web-origin'

const webUrl = readWebOrigin(process.env.NEXT_PUBLIC_WEB_URL)

// Better Auth manages the browser session through the same-origin API proxy.
// The API remains responsible for verifying that session on protected operations.
// 
// Export the whole client — never destructure at module level.
// TS cannot infer internal types like SessionQueryParams portably.
// Consumers import authClient and call methods directly.
export const authClient = createAuthClient({
  baseURL: webUrl,
})
