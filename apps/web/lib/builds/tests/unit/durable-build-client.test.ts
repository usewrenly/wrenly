import { describe, expect, test } from 'bun:test'
import { followDurableBuild, parseDurableSnapshot, queuedBuildMessage, submitDurableBuild } from '../../durable-build-client'
const ID = '101e4567-e89b-12d3-a456-426614174007'
function snapshot(outcome = 'running', cursor = 1): object {
  return { outcome, cursor, build: { id: ID, status: outcome === 'success' ? 'success' : 'generating',
    attemptCount: 1, files: [{ path: 'package.json', content: '{}' }], buildLog: '', errorMessage: null, deployedUrl: null } }
}
function stream(sequence: number): Response {
  return new Response(`id: ${sequence}\nevent: complete\ndata: ${JSON.stringify({ buildId: ID, success: true, attempt: 1 })}\n\n`)
}
describe('durable build observation', () => {
  test('terminal snapshot needs no stream or new admission', async () => {
    const paths: string[] = []
    await followDurableBuild(ID, { signal: new AbortController().signal,
      fetch: async path => { paths.push(path); return Response.json(snapshot('success')) },
      snapshot: () => {}, event: () => { throw new Error('No event expected') }, connection: () => {},
    })
    expect(paths).toEqual([`/api/builds/${ID}`])
  })
  test('subscribes after atomic snapshot cursor and delivers ordered events', async () => {
    const paths: string[] = []
    let delivered = 0
    await followDurableBuild(ID, { signal: new AbortController().signal,
      fetch: async path => { paths.push(path); return path.includes('/events') ? stream(2) : Response.json(snapshot()) },
      snapshot: () => {}, event: () => { delivered++ }, connection: () => {},
    })
    expect(paths[1]).toBe(`/api/builds/${ID}/events?after=1`)
    expect(delivered).toBe(1)
  })
  test('transport loss reloads canonical snapshot without resubmitting', async () => {
    let reads = 0
    const paths: string[] = []
    await followDurableBuild(ID, { signal: new AbortController().signal,
      fetch: async path => {
        paths.push(path)
        if (path.includes('/events')) return new Response(': heartbeat\n\n')
        return Response.json(snapshot(++reads === 1 ? 'running' : 'success'))
      }, snapshot: () => {}, event: () => {}, connection: () => {},
    })
    expect(reads).toBe(2)
    expect(paths).not.toContain('/api/builds')
  })
  test('rejects another build’s replay before callbacks and restores from saved state', async () => {
    let reads = 0
    let delivered = 0
    const paths: string[] = []
    await followDurableBuild(ID, { signal: new AbortController().signal,
      fetch: async path => {
        paths.push(path)
        if (path.includes('/events')) return new Response(`id: 2\nevent: complete\ndata: ${JSON.stringify({ buildId: 'different-build', success: true })}\n\n`)
        return Response.json(snapshot(++reads === 1 ? 'running' : 'success'))
      }, snapshot: () => {}, event: () => { delivered++ }, connection: () => {},
    })
    expect(delivered).toBe(0)
    expect(reads).toBe(2)
    expect(paths).not.toContain('/api/builds')
  })
  test('cancellation during an unavailable snapshot stops observation without submission', async () => {
    const controller = new AbortController()
    const paths: string[] = []
    await followDurableBuild(ID, { signal: controller.signal,
      fetch: async path => { paths.push(path); controller.abort(); throw new Error('Tab closed') },
      snapshot: () => { throw new Error('No snapshot expected') }, event: () => {}, connection: () => {},
    })
    expect(paths).toEqual([`/api/builds/${ID}`])
  })
  test('lost acknowledgement reuses the same idempotency key', async () => {
    const keys: string[] = []
    const id = await submitDurableBuild({ prompt: 'Build' }, 'stable-key', async (_path, options) => {
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!)
      if (keys.length === 1) throw new Error('Socket closed after commit')
      return Response.json({ buildId: ID, replayed: true })
    }, new AbortController().signal)
    expect(id).toBe(ID)
    expect(keys).toEqual(['stable-key', 'stable-key'])
  })
  test('explicit admission failure is surfaced without retry', async () => {
    let calls = 0
    await expect(submitDurableBuild({}, 'key', async () => {
      calls++; return Response.json({ error: 'Project already active' }, { status: 409 })
    }, new AbortController().signal)).rejects.toThrow('Project already active')
    expect(calls).toBe(1)
  })
  test('rejects untrusted snapshot files/cursors before hydration', () => {
    expect(() => parseDurableSnapshot({ ...snapshot(), cursor: -1 })).toThrow('Invalid')
    expect(() => parseDurableSnapshot({ ...snapshot(), build: { files: 'bad' } })).toThrow('Invalid')
  })
})


test('queued explanations distinguish busy worker, recovery and unclaimed work', () => {
  expect(queuedBuildMessage({ position: 2, reason: 'busy' })).toContain('another build')
  expect(queuedBuildMessage({ position: 2, reason: 'busy' })).toContain('2')
  expect(queuedBuildMessage({ position: 1, reason: 'recovering' })).toContain('cleaning up')
  expect(queuedBuildMessage(undefined)).toContain('API worker')
  expect(() => parseDurableSnapshot({ ...snapshot(), queue: { position: 0, reason: 'busy' } })).toThrow('queue')
})
