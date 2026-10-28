const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const PUBLISHING_STORAGE_MESSAGE = 'Publishing recovery needs browser storage. Allow site storage and reload before publishing.'
/** An unreadable or malformed saved identity must not become a fresh deployment request. */
export function readPublishingKey(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    const value = storage.getItem(key)
    if (value !== null && !REQUEST_ID.test(value)) throw new Error()
    return value
  } catch { throw new Error(PUBLISHING_STORAGE_MESSAGE) }
}
/** Persist before POST so refreshing an uncertain request can reuse the same identity. */
export function persistPublishingKey(storage: Pick<Storage, 'setItem'>, key: string, requestId: string): void {
  try {
    if (!REQUEST_ID.test(requestId)) throw new Error()
    storage.setItem(key, requestId)
  } catch { throw new Error(PUBLISHING_STORAGE_MESSAGE) }
}
