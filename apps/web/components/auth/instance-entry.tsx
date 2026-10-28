'use client'
// Errors never imply an empty instance.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { EntryLoading } from './entry-loading'
import { apiFetch } from '@/lib/api'
const SETUP_CHECK_TIMEOUT_MS = 10_000 // An unavailable API must not leave setup waiting indefinitely.

type Status = 'checking' | 'setup-required' | 'initialized' | 'recovery-required' | 'error'

/** Routes first-run visitors using authoritative setup state, with a retry on failure. */
export function InstanceEntry({ kind, children }: { kind: 'setup' | 'sign-in'; children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<Status>('checking')
  const [retry, setRetry] = useState(0)
  const router = useRouter()
  useEffect(() => {
    const controller = new AbortController()
    setStatus('checking')
    const check = async (): Promise<void> => {
      try {
        const response = await apiFetch('/api/instance/setup', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SETUP_CHECK_TIMEOUT_MS)]) })
        const data: unknown = await response.json()
        if (!response.ok || !data || typeof data !== 'object' || !('status' in data) ||
          !['setup-required', 'initialized', 'recovery-required'].includes(String(data.status))) throw new Error('Setup state unavailable')
        if (!controller.signal.aborted) setStatus(data.status as Status)
      } catch { if (!controller.signal.aborted) setStatus('error') }
    }
    void check(); return () => controller.abort()
  }, [retry])
  useEffect(() => {
    if (kind === 'sign-in' && status === 'setup-required') router.replace('/setup')
    if (kind === 'setup' && status === 'initialized') router.replace('/sign-in')
  }, [kind, status, router])
  if (status === 'error') return <div role="alert" className="entry-message space-y-3"><p>Instance setup is unavailable. Check your connection and try again.</p><button type="button" onClick={() => setRetry(value => value + 1)} className="underline">Try again</button></div>
  if (status === 'checking') return <EntryLoading label="Checking instance setup…" />
  if (kind === 'setup' && status === 'recovery-required') return <div className="space-y-3"><p>This instance already has accounts. Ask its operator to complete verified owner recovery. Your data is preserved.</p><a href="/sign-in" className="underline">Sign in to an existing account</a></div>
  if (kind === 'sign-in' && status === 'setup-required' || kind === 'setup' && status === 'initialized') return <EntryLoading label="Opening the correct sign-in page…" />
  return <>{children}</>
}
