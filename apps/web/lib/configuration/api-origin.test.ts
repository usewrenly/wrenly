import { describe, expect, test } from 'bun:test'
import { readApiOrigin } from './api-origin'

describe('API proxy origin', () => {
  test('preserves an operator-selected host and port', () => {
    expect(readApiOrigin('http://localhost:4012/')).toBe('http://localhost:4012')
    expect(readApiOrigin('https://api.example.test')).toBe('https://api.example.test')
  })

  test('rejects missing or ambiguous destinations without exposing their values', () => {
    for (const value of [undefined, '', 'ftp://localhost', 'https://user:secret@example.test',
      'https://example.test/api', 'https://example.test?key=secret', 'https://example.test#fragment',
      ' https://example.test', 'https://exam\nple.test']) {
      expect(() => readApiOrigin(value)).toThrow('Set NEXT_PUBLIC_API_URL')
      try { readApiOrigin(value) } catch (error) {
        expect(String(error)).not.toContain('secret')
      }
    }
  })
})
