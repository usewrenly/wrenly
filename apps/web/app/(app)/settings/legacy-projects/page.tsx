'use client'
// Selection is never confirmation.
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api'
type Project = { id: string; name: string }
type Review = { reviewId: string | null; projects: Project[]; blockers: string[] }
function isProjects(value: unknown): value is Project[] {
  return Array.isArray(value) && value.every(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string')
}
async function readResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : 'Project recovery is unavailable.')
  return value
}
export default function LegacyProjectsPage(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [email, setEmail] = useState('')
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [reload, setReload] = useState(0)
  const requestId = useRef<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setBusy(true); setError(''); setReview(null); setSelected([])
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        const [inventory, session] = await Promise.all([
          apiFetch('/api/instance/legacy-projects', { cache: 'no-store', signal }).then(readResponse),
          apiFetch('/api/auth/get-session', { cache: 'no-store', signal }).then(readResponse),
        ])
        if (!inventory || typeof inventory !== 'object' || !('projects' in inventory) || !isProjects(inventory.projects)) throw new Error('Project inventory could not be read.')
        if (!session || typeof session !== 'object' || !('user' in session) || !session.user || typeof session.user !== 'object' || !('email' in session.user) || typeof session.user.email !== 'string') throw new Error('Your signed-in account could not be checked.')
        if (!controller.signal.aborted) { setProjects(inventory.projects); setMore('more' in inventory && inventory.more === true); setEmail(session.user.email) }
      } catch (failure) { if (!controller.signal.aborted) { setProjects([]); setError(failure instanceof Error ? failure.message : 'Project recovery is unavailable.') } }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void load(); return () => controller.abort()
  }, [reload])
  const reviewSelection = async (): Promise<void> => {
    setBusy(true); setError(''); setReview(null); requestId.current = null
    try {
      const value = await readResponse(await apiFetch('/api/instance/legacy-projects/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectIds: selected }), signal: AbortSignal.timeout(15_000) }))
      if (!value || typeof value !== 'object' || !('reviewId' in value) || !(value.reviewId === null || typeof value.reviewId === 'string') || !('projects' in value) || !isProjects(value.projects) || !('blockers' in value) || !Array.isArray(value.blockers) || !value.blockers.every(item => typeof item === 'string')) throw new Error('Recovery review could not be read.')
      setReview({ reviewId: value.reviewId, projects: value.projects, blockers: value.blockers })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review failed.') }
    finally { setBusy(false) }
  }
  const confirm = async (): Promise<void> => {
    if (!review?.reviewId) return
    setBusy(true); setError('')
    try {
      requestId.current ??= crypto.randomUUID()
      const value = await readResponse(await apiFetch('/api/instance/legacy-projects/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: review.reviewId, requestId: requestId.current }), signal: AbortSignal.timeout(15_000) }))
      if (!value || typeof value !== 'object' || !('transferred' in value) || typeof value.transferred !== 'number') throw new Error('Recovery result could not be read. Retry this confirmation.')
      setResult(`${value.transferred} project${value.transferred === 1 ? '' : 's'} recovered. History is preserved and old preview access is revoked.`)
      setReload(count => count + 1)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Confirmation failed. Retry this confirmation.') }
    finally { setBusy(false) }
  }
  return <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
    <a href="/settings" className="text-sm underline">Back to settings</a>
    <h1 className="text-2xl font-semibold">Recover legacy projects</h1>
    <p>Recover selected projects from the former local identity into your instance-owner account. Other users’ projects are excluded.</p>
    {result && <p role="status">{result} <a href="/" className="underline">Open projects</a></p>}
    {error && <div role="alert" className="space-y-2"><p>{error}</p><button type="button" disabled={busy} onClick={() => setReload(count => count + 1)} className="underline">Refresh inventory</button></div>}
    {busy && <p role="status">Checking recovery…</p>}
    {review ? <section className="space-y-4 rounded border p-4"><h2 className="font-semibold">Review recovery</h2><p>Destination: <strong>{email}</strong></p>
      <ul className="space-y-2">{review.projects.map(project => <li key={project.id}>{project.name}<span className="block break-all text-xs opacity-70">{project.id}</span></li>)}</ul>
      {review.blockers.length ? <div role="alert"><p>Resolve these before reviewing again:</p><ul>{review.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div> : <p>Files, conversations and build history stay intact. Previous preview links will stop working. This review expires in ten minutes.</p>}
      <div className="flex gap-4"><button type="button" disabled={busy} onClick={() => { setReview(null); requestId.current = null }} className="underline">Change selection</button>
      {review.reviewId && <button type="button" disabled={busy} onClick={() => { void confirm() }} className="rounded border px-4 py-2">Confirm recovery</button>}</div>
    </section> : <section className="space-y-4">
      {!busy && !error && !projects.length && <p>No legacy projects need recovery.</p>}
      {projects.map(project => <label key={project.id} className="flex items-start gap-3 rounded border p-3"><input type="checkbox" checked={selected.includes(project.id)} disabled={busy || selected.length >= 20 && !selected.includes(project.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} /><span>{project.name}<span className="block break-all text-xs opacity-70">{project.id}</span></span></label>)}
      {more && <p>Showing the first 100 projects. Recover a batch, then refresh to see more.</p>}
      {!!projects.length && <button type="button" disabled={busy || !selected.length} onClick={() => { void reviewSelection() }} className="rounded border px-4 py-2 disabled:opacity-50">Review {selected.length} selected project{selected.length === 1 ? '' : 's'}</button>}
    </section>}
  </main>
}
