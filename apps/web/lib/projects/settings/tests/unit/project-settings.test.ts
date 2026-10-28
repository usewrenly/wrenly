import { expect, spyOn, test } from 'bun:test'
import { requestProjectSettings } from '../../project-settings'
const project = { id: 'selected-project', name: 'Booking app', description: null, stack: 'laravel', access: 'private' as const,
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' }

test('settings rechecks the requested project for success and conflict snapshots', async () => {
  const fetch = spyOn(globalThis, 'fetch')
  try {
    fetch.mockResolvedValueOnce(Response.json({ project }))
    expect(await requestProjectSettings(project.id)).toEqual(project)
    fetch.mockResolvedValueOnce(Response.json({ project: { ...project, id: 'another-project' } }))
    await expect(requestProjectSettings(project.id)).rejects.toThrow('do not match')
    fetch.mockResolvedValueOnce(Response.json({ current: { ...project, id: 'another-project' } }, { status: 409 }))
    await expect(requestProjectSettings(project.id)).rejects.toThrow('do not match')
  } finally { fetch.mockRestore() }
})

test('conflict review retains the current matching snapshot and does not resubmit', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ current: project, error: 'Review newer details' }, { status: 409 }))
  try {
    await expect(requestProjectSettings(project.id, { name: 'New name', description: null,
      expected: { name: project.name, description: null } })).rejects.toMatchObject({ status: 409, current: project })
    expect(fetch).toHaveBeenCalledTimes(1)
    const options = fetch.mock.calls[0]?.[1]
    expect(options?.credentials).toBe('include')
    expect(options?.cache).toBe('no-store')
  } finally { fetch.mockRestore() }
})
