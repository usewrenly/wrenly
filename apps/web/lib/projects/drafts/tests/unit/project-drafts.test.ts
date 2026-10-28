import { expect, spyOn, test } from 'bun:test'
import { draftRequest, parseDraft, parseDraftList, type ProjectDraft } from '../../project-drafts'
const draft: ProjectDraft = { id: 'selected-idea', title: 'Booking app', body: 'Rough idea', revision: 'revision',
  accessMode: 'private', instanceRole: 'viewer', archivedAt: null, updatedAt: '2026-10-23T00:00:00Z',
  updatedByName: 'Owner', capabilities: { role: 'owner', contribute: true, manage: true }, members: [] }

test('draft validation checks identity and authority before editor state', () => {
  expect(parseDraft(draft, draft.id)).toEqual(draft)
  expect(() => parseDraft(draft, 'another-idea')).toThrow('does not match')
  expect(() => parseDraft({ ...draft, capabilities: { role: 'owner' } })).toThrow('permissions')
  expect(() => parseDraft({ ...draft, capabilities: { role: 'viewer', contribute: true, manage: true } })).toThrow('permissions')
  expect(() => parseDraft({ ...draft, members: [{ userId: 'member', name: 'Member', role: 'owner' }] })).toThrow('member role')
  expect(() => parseDraftList({ drafts: [{ ...draft, owned: 'yes' }], hasMore: false })).toThrow('owner')
})

test('draft mutation uses authenticated no-store PATCH and does not repeat uncertain work', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Internal diagnostic'))
  try {
    await expect(draftRequest('/api/drafts/selected-idea', { requestId: 'stable', revision: 'revision', body: 'Idea' }))
      .rejects.toMatchObject({ status: 503, message: 'Draft operation could not be confirmed. Keep your text and retry.' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH', cache: 'no-store', credentials: 'include' })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe('application/json')
  } finally { fetch.mockRestore() }
})
