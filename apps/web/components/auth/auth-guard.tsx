'use client'
// The API verifies the session for every installation, including one-person instances.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { EntryLoading } from './entry-loading'
import { apiFetch } from '@/lib/api'
const ACCESS_TIMEOUT_MS = 10_000
const MIN_WORKSPACE_ENTRY_MS = 1_200 // Avoid a flash between sign-in and the workspace.
type AccessState = 'checking' | 'allowed' | 'sign-in-required' | 'error'

/** Waits for verified instance access before displaying authenticated screens. */
export function AuthGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter()
  const [state, setState] = useState<AccessState>('checking')
  const [attempt, setAttempt] = useState(0)
  const [entrySettled, setEntrySettled] = useState(false)
  // Presentation waits independently of access: failures and sign-in redirects stay
  // immediate, and the timer can never make an unauthenticated screen accessible.
  useEffect(() => {
    const timer = setTimeout(() => setEntrySettled(true), MIN_WORKSPACE_ENTRY_MS)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setState('checking')
    const check = async (): Promise<void> => {
      try {
        const response = await apiFetch('/api/instance/access', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ACCESS_TIMEOUT_MS)]) })
        if (!response.ok) throw new Error('Access check unavailable')
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object' || !('mode' in value) || !('access' in value)) throw new Error('Invalid access response')
        let next: AccessState
        if (['single-user', 'multi-user'].includes(String(value.mode)) && value.access === 'authenticated') next = 'allowed'
        else if (['single-user', 'multi-user'].includes(String(value.mode)) && value.access === 'sign-in-required') next = 'sign-in-required'
        else throw new Error('Invalid access state')
        if (!controller.signal.aborted) setState(next)
      } catch { if (!controller.signal.aborted) setState('error') }
    }
    void check()
    return () => controller.abort()
  }, [attempt])
  useEffect(() => { if (state === 'sign-in-required') router.replace('/sign-in') }, [state, router])
  if (state === 'allowed' && entrySettled) return <>{children}</>
  return <div className="flex min-h-screen items-center justify-center p-6">
    {state === 'error' ? <div role="alert" className="max-w-sm space-y-3 text-center">
      <p>We couldn’t check access to this instance. Check your connection and try again.</p>
      <button type="button" className="rounded border px-4 py-2" onClick={() => setAttempt(value => value + 1)}>Try again</button>
    </div> : <EntryLoading label={state === 'allowed' ? 'Opening your workspace…' : state === 'checking' ? 'Checking instance access…' : 'Opening sign-in…'} />}
  </div>
}
