import { expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { skillRequest } from '../../client'

test('Skills reads retain credentials, no-store and caller cancellation with a deadline', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ ready: true }))
  const controller = new AbortController()
  try {
    expect(await skillRequest('/api/skills', z.object({ ready: z.boolean() }), { signal: controller.signal, cache: 'force-cache' })).toEqual({ ready: true })
    const options = fetch.mock.calls[0]?.[1]
    expect(options?.cache).toBe('no-store')
    expect(options?.credentials).toBe('include')
    expect(options?.signal?.aborted).toBe(false)
    controller.abort()
    expect(options?.signal?.aborted).toBe(true)
  } finally { fetch.mockRestore() }
})

test('Skills acknowledgement validation and transport failures remain unconfirmed', async () => {
  const fetch = spyOn(globalThis, 'fetch')
  try {
    fetch.mockResolvedValueOnce(Response.json({ ready: 'incorrect' }))
    await expect(skillRequest('/api/skills', z.object({ ready: z.boolean() }))).rejects.toMatchObject({ status: 0 })
    fetch.mockRejectedValueOnce(new Error('Private diagnostic'))
    await expect(skillRequest('/api/skills', z.object({ ready: z.boolean() }))).rejects.toMatchObject({ status: 0, message: 'The response could not be confirmed. Keep your text and check the saved change before retrying.' })
    fetch.mockResolvedValueOnce(Response.json({ error: 'Review current version' }, { status: 409 }))
    await expect(skillRequest('/api/skills', z.object({ ready: z.boolean() }))).rejects.toMatchObject({ status: 409, message: 'Review current version' })
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally { fetch.mockRestore() }
})
