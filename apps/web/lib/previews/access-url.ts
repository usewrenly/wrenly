/** Allows only browser navigation to an absolute HTTP(S) preview link without embedded credentials. */
export function parsePreviewAccessUrl(value: unknown): string {
  try {
    if (typeof value !== 'string' || value !== value.trim() || /\s/.test(value)) throw new Error()
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    return url.href
  } catch { throw new Error('Preview access returned an invalid link. Refresh before opening it.') }
}
