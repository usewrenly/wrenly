import { expect, test } from 'bun:test'
import { parsePreviewAccessUrl } from '../../access-url'
test('preview navigation accepts HTTP(S) links but never executable or credential URLs', () => {
  expect(parsePreviewAccessUrl('http://preview.localhost:3003/bootstrap?ticket=fixture')).toBe('http://preview.localhost:3003/bootstrap?ticket=fixture')
  for (const value of [null, '/relative', 'javascript:alert(1)', 'data:text/html,hello', 'https://user:secret@example.test', ' https://example.test'])
    expect(() => parsePreviewAccessUrl(value)).toThrow('invalid link')
})
