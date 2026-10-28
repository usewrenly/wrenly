import { z } from 'zod'

const apiOriginSchema = z.string().min(1).refine(value => {
  try {
    const url = new URL(value)
    return value === value.trim() && !/\s/.test(value)
      && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash
  } catch {
    return false
  }
})

/** Keeps the server proxy on the operator's explicit API origin without accepting embedded credentials. */
export function readApiOrigin(value: string | undefined): string {
  const parsed = apiOriginSchema.safeParse(value)
  if (!parsed.success) {
    // Configuration errors must not repeat a mistakenly pasted credential-bearing URL.
    throw new Error('Set NEXT_PUBLIC_API_URL to an HTTP(S) API origin without credentials, a path, query or fragment.')
  }
  return new URL(parsed.data).origin
}
