import { describe, expect, test } from 'bun:test'
import { parseConversationHistory, parseConversationRequest } from '../../contracts'

const empty = { conversationId: null, messages: [], turns: [], latestTurn: null, nextCursor: null }
const message = { id: 'message', turnId: 'turn', sequence: 1, role: 'user' as const,
  content: 'Plan a booking app', kind: 'message', createdAt: '2026-10-23T10:00:00Z' }

describe('saved conversation contracts', () => {
  test('rejects malformed history and identities before rendering', () => {
    expect(parseConversationHistory(empty).messages).toEqual([])
    expect(() => parseConversationHistory({ ...empty, latestTurn: { id: 'forged', status: 'success' } })).toThrow('invalid conversation history')
    expect(() => parseConversationHistory({ ...empty, messages: [{ ...message, sequence: -1 }] })).toThrow()
    expect(() => parseConversationHistory({ ...empty, messages: [{ ...message, actorId: {} }] })).toThrow()
    expect(() => parseConversationHistory({ ...empty, messages: [{ ...message, author: { id: 'user', name: 'User', pictureUrl: 42 } }] })).toThrow()
  })
  test('retains older unattributed messages and current attributed messages', () => {
    expect(parseConversationHistory({ ...empty, messages: [message] }).messages[0]).toEqual(message)
    const attributed = { ...message, actorId: 'user', author: { id: 'user', name: 'User', pictureUrl: null } }
    expect(parseConversationHistory({ ...empty, messages: [attributed] }).messages[0]).toEqual(attributed)
  })
  test('restores Plan with the selected revision and excludes unrelated action fields', () => {
    const saved = { message: 'Plan a booking app', mode: 'plan' as const, baseBuildId: 'selected-revision',
      model: 'model', provider: 'provider' }
    expect(parseConversationRequest({ ...saved, deploy: true, projectId: 'another-project' })).toEqual(saved)
    expect(() => parseConversationRequest({ ...saved, mode: 'execute' })).toThrow('could not be restored')
    expect(() => parseConversationRequest({ ...saved, message: ' ' })).toThrow('could not be restored')
  })
})

test('saved database choices survive recovery and malformed choices are never silently dropped', () => {
  const database = { version: 1 as const, environment: 'development' as const, resourceId: crypto.randomUUID(), resourceRevision: crypto.randomUUID() }
  const request = { message: 'Build reservations', mode: 'auto' as const, baseBuildId: null, database }
  expect(parseConversationRequest(JSON.parse(JSON.stringify(request)))).toEqual(request)
  expect(() => parseConversationRequest({ ...request, database: { ...database, password: 'PRIVATE' } })).toThrow()
  const turn = { id: 'turn', mode: 'auto', status: 'failed', baseBuildId: null, buildId: null, errorMessage: 'Failed', model: 'model', provider: 'provider', database }
  expect(parseConversationHistory({ ...empty, turns: [turn], latestTurn: turn }).latestTurn?.database).toEqual(database)
  expect(() => parseConversationHistory({ ...empty, latestTurn: { ...turn, database: { ...database, environment: 'production' } } })).toThrow()
})
