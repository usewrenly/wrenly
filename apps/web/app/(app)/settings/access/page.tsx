'use client'
// Private links exist only in the issuing owner's current page memory.
import { MemberAccessManager } from '@/components/settings/access/member-access-manager'
import { parseAccountAccess as parseAccess } from '@/lib/accounts/member-access'
import { useEffect, useRef, useState } from 'react'
import { invitationRequest } from '@/lib/accounts/invitations'
export default function InstanceAccessPage(): React.JSX.Element {
  const [access, setAccess] = useState<ReturnType<typeof parseAccess> | null>(null)
  const [email, setEmail] = useState('')
  const [link, setLink] = useState<{ id: string; value: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [reload, setReload] = useState(0)
  const requestId = useRef<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const load = async (): Promise<void> => {
      setBusy(true); setError('')
      try { const value = parseAccess(await invitationRequest('/api/instance/access/members', undefined, controller.signal)); if (!controller.signal.aborted) setAccess(value) }
      catch (failure) { if (!controller.signal.aborted) { setAccess(null); setError(failure instanceof Error ? failure.message : 'Instance access is unavailable.') } }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void load(); return () => controller.abort()
  }, [reload])
  const initialize = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await invitationRequest('/api/instance/access/initialize', {}); setReload(count => count + 1) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Membership could not be initialized.') }
    finally { setBusy(false) }
  }
  const issue = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(''); setLink(null)
    try {
      requestId.current ??= crypto.randomUUID()
      const value = await invitationRequest('/api/instance/invitations', { email, requestId: requestId.current })
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !('link' in value) || typeof value.link !== 'string') throw new Error('The invitation was recorded but its link could not be read. Refresh and revoke it before issuing another.')
      setLink({ id: value.id, value: value.link }); setEmail(''); requestId.current = null
      setAccess(parseAccess(await invitationRequest('/api/instance/access/members')))
    } catch (failure) { setError(`${failure instanceof Error ? failure.message : 'Invitation could not be issued.'} If its acknowledgement was lost, refresh the list before trying again.`) }
    finally { setBusy(false) }
  }
  const revoke = async (id: string): Promise<void> => {
    setBusy(true); setError('')
    try {
      await invitationRequest('/api/instance/invitations/revoke', { id })
      if (link?.id === id) setLink(null)
      setAccess(parseAccess(await invitationRequest('/api/instance/access/members')))
      requestId.current = null
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Invitation could not be revoked.') }
    finally { setBusy(false) }
  }
  return <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">Instance access</h1>
    <p>Invite people to use this Wrenly instance. Members create their own private projects; invitations do not share your projects or grant administration.</p>
    {error && <div role="alert" className="space-y-2"><p>{error}</p><button type="button" disabled={busy} onClick={() => setReload(count => count + 1)} className="underline">Refresh access list</button></div>}
    {busy && <p role="status">Updating instance access…</p>}
    {access && !access.members.length && <section className="space-y-3 rounded border p-4"><p>Enable invitation management for this instance. Your owner account and existing projects stay intact.</p><button type="button" disabled={busy} onClick={() => { void initialize() }} className="rounded border px-4 py-2">Enable invitations</button></section>}
    {access && !!access.members.length && <>
      <form id="invite-member" onSubmit={event => { void issue(event) }} className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">Invite a member</h2>
        <label className="block">Email<input type="email" required maxLength={254} value={email} onChange={event => { setEmail(event.target.value); requestId.current = null }} className="mt-2 w-full rounded border bg-transparent p-2" /></label>
        <p className="text-sm opacity-70">The private link expires after 48 hours. Share it with this person through a trusted channel.</p>
        <button type="submit" disabled={busy || !email} className="rounded border px-4 py-2 disabled:opacity-50">Create invitation</button>
      </form>
      {link && <section className="space-y-3 rounded border p-4"><h2 className="font-semibold">Private invitation link</h2><p>Copy and share it privately. It will not be displayed again after you leave this page.</p><input aria-label="Private invitation link" readOnly value={link.value} onFocus={event => event.target.select()} className="w-full rounded border bg-transparent p-2 text-sm" /><button type="button" onClick={() => setLink(null)} className="underline">Hide link</button></section>}
      <MemberAccessManager members={access.members} onRefresh={async()=>setAccess(parseAccess(await invitationRequest('/api/instance/access/members')))} />
      <section className="space-y-3"><h2 className="font-semibold">Invitations</h2>{!access.invitations.length && <p>No invitations yet.</p>}<ul className="space-y-2">{access.invitations.map(item => <li key={item.id} className="space-y-2 rounded border p-3"><p>{item.email} · {item.status}</p><p className="text-sm opacity-70">Expires {new Date(item.expiresAt).toLocaleString()}</p>{['pending', 'expired'].includes(item.status) && <button type="button" disabled={busy} onClick={() => { void revoke(item.id) }} className="underline">Revoke invitation</button>}</li>)}</ul></section>
    </>}
  </main>
}
