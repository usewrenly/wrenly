import { describe, expect, test } from 'bun:test'
import { validateFilePaths } from '../src/source-policy/file-paths'

describe('sandbox paths', () => {
  test('accepts portable nested application files', () => {
    expect(() => validateFilePaths([{ path: 'package.json' }, { path: 'app/page.tsx' }])).not.toThrow()
  })
  test.each(['../outside', '../sandbox-sibling/file', '/etc/passwd', 'C:/file', 'a\\b', './a', 'a//b', 'a/../b', 'a/', '', 'a\0b'])('rejects unsafe path %j', (name) => {
    expect(() => validateFilePaths([{ path: name }])).toThrow('unsafe')
  })
  test('rejects duplicate and ancestor collisions before writing', () => {
    expect(() => validateFilePaths([{ path: 'a' }, { path: 'a' }])).toThrow('duplicate')
    expect(() => validateFilePaths([{ path: 'a/b/c' }, { path: 'a' }])).toThrow('collision')
  })
})
