import { expect, spyOn, test } from 'bun:test'
import { readOwnPicture } from '../../profile-pictures'
import { invitationRequest } from '../../invitations'
const picture = { userId: 'current-user', revision: 'revision', mutationId: 'mutation', url: '/api/account/profile-picture/image?revision=revision' }

test('picture reads check account identity, project only metadata and preserve cancellation', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ ...picture, privateField: 'not-retained' }))
  const controller = new AbortController()
  try {
    expect(await readOwnPicture('current-user', controller.signal)).toEqual(picture)
    const signal = fetch.mock.calls[0]?.[1]?.signal
    controller.abort()
    expect(signal?.aborted).toBe(true)
    fetch.mockResolvedValueOnce(Response.json(picture))
    await expect(readOwnPicture('other-user')).rejects.toThrow('could not be checked')
    fetch.mockResolvedValueOnce(Response.json({ ...picture, url: 'https://external.example/image' }))
    await expect(readOwnPicture('current-user')).rejects.toThrow('could not be checked')
  } finally { fetch.mockRestore() }
})

test('invitation requests preserve API errors, bound/cancel reads and do not repeat mutations', async () => {
  const fetch = spyOn(globalThis, 'fetch')
  const controller = new AbortController()
  try {
    fetch.mockResolvedValueOnce(Response.json({ error: 'Only the owner may invite' }, { status: 403 }))
    await expect(invitationRequest('/api/instance/invitations', {}, controller.signal)).rejects.toThrow('Only the owner may invite')
    const options = fetch.mock.calls[0]?.[1]
    expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', method: 'POST' })
    controller.abort()
    expect(options?.signal?.aborted).toBe(true)
    fetch.mockRejectedValueOnce(new Error('Private connection diagnostic'))
    await expect(invitationRequest('/api/instance/invitations', {})).rejects.toThrow('Refresh saved invitations')
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally { fetch.mockRestore() }
})
