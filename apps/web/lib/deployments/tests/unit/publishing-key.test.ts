import { expect, test } from 'bun:test'
import { readPublishingKey, persistPublishingKey } from '../../publishing-key'
const id = '101e4567-e89b-12d3-a456-426614174007'
test('publishing identity survives an exact read/write and absent storage stays absent', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value) } }
  expect(readPublishingKey(storage, 'key')).toBeNull()
  persistPublishingKey(storage, 'key', id)
  expect(readPublishingKey(storage, 'key')).toBe(id)
})
test('unreadable/corrupt identity and failed persistence never appear as successful recovery', () => {
  expect(() => readPublishingKey({ getItem: () => 'corrupted' }, 'key')).toThrow('Allow site storage')
  expect(() => readPublishingKey({ getItem: () => { throw new Error('Private diagnostic') } }, 'key')).toThrow('reload before publishing')
  expect(() => persistPublishingKey({ setItem: () => { throw new Error('Quota exceeded') } }, 'key', id)).toThrow('Allow site storage')
})
