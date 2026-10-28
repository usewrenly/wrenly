/**
 * Request identity context.
 * Hono creates one asynchronous scope per API request.
 * Session verification captures the authenticated account, session and access revision here so transactional admissions can reject a principal suspended or restored while its request was running.
 */
import { AsyncLocalStorage } from "node:async_hooks";
export interface AccessPrincipal {
  userId: string;
  sessionId: string;
  revision: string;
}
export const accessContext = new AsyncLocalStorage<{
  principal?: AccessPrincipal;
}>();
