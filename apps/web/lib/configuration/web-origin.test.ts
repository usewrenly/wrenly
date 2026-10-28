import { expect, test } from 'bun:test'
import { readWebOrigin } from './web-origin'

test('auth uses the configured web origin with a normalized trailing slash', () => {
  expect(readWebOrigin('http://localhost:3000/')).toBe('http://localhost:3000')
  expect(readWebOrigin('https://builder.example.test')).toBe('https://builder.example.test')
})
test('invalid auth configuration fails with a safe actionable field error', () => {
  for (const value of [undefined, '', 'ftp://localhost', 'https://user:secret@example.test', 'https://example.test/sign-in', 'https://example.test?q=secret', 'https://example.test#proof', ' https://example.test']) {
    expect(() => readWebOrigin(value)).toThrow('Set NEXT_PUBLIC_WEB_URL')
    try { readWebOrigin(value) } catch (error) { expect(String(error)).not.toContain('secret') }
  }
})
