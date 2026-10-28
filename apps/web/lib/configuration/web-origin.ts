import { z } from 'zod'

const webOriginSchema = z.string().min(1).refine(value => {
  try {
    const url = new URL(value)
    return value === value.trim() && !/\s/.test(value)
      && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash
  } catch { return false }
})

/** Validates the browser-facing Better Auth origin without echoing mistaken credentials. */
export function readWebOrigin(value: string | undefined): string {
  const parsed = webOriginSchema.safeParse(value)
  if (!parsed.success) throw new Error('Set NEXT_PUBLIC_WEB_URL to the HTTP(S) web origin without credentials, a path, query or fragment.')
  return new URL(parsed.data).origin
}
