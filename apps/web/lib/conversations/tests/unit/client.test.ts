import { describe, expect, test } from 'bun:test'
import { ConversationAcceptanceUnknownError, submitConversationTurn } from '../../client'
const request = { message: 'Why did it fail?', mode: 'ask' as const, baseBuildId: 'selected-old-revision', model: 'model', provider: 'provider' }

describe('conversation browser admission', () => {
  test('lost acknowledgement reuses one key and frozen selected revision', async () => {
    const calls: RequestInit[] = []
    const id = await submitConversationTurn('project', request, 'stable-key', async (_, init) => {
      calls.push(init!); if (calls.length === 1) throw new Error('Connection lost')
      return Response.json({ turnId: 'one-turn' })
    }, new AbortController().signal)
    expect(id).toBe('one-turn'); expect(calls).toHaveLength(2)
    expect(calls.map(call => new Headers(call.headers).get('Idempotency-Key'))).toEqual(['stable-key', 'stable-key'])
    expect(calls.map(call => JSON.parse(String(call.body)).baseBuildId)).toEqual(['selected-old-revision', 'selected-old-revision'])
  })
  test('server ambiguity never silently becomes a new submission', async () => {
    await expect(submitConversationTurn('project', request, 'key', async () => Response.json({ error: 'Unavailable' }, { status: 503 }), new AbortController().signal)).rejects.toBeInstanceOf(ConversationAcceptanceUnknownError)
    await expect(submitConversationTurn('project', request, 'key', async () => Response.json({ error: 'Choose a revision' }, { status: 409 }), new AbortController().signal)).rejects.toThrow('Choose a revision')
  })
  test('acknowledgement retries preserve the body even if caller state changes', async () => {
    const mutable = { ...request }
    const bodies: string[] = []
    await submitConversationTurn('project', mutable, 'stable-key', async (_, init) => {
      bodies.push(String(init?.body))
      if (bodies.length === 1) {
        mutable.message = 'A different request'
        mutable.baseBuildId = 'a-different-revision'
        throw new Error('Acknowledgement lost')
      }
      return Response.json({ turnId: 'one-turn' })
    }, new AbortController().signal)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[1]!)).toMatchObject(request)
  })
  test('empty success identity remains uncertain rather than clearing the pending request', async () => {
    await expect(submitConversationTurn('project', request, 'key',
      async () => Response.json({ turnId: '' }), new AbortController().signal))
      .rejects.toBeInstanceOf(ConversationAcceptanceUnknownError)
  })

})
