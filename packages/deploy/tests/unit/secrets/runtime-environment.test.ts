import { expect, test } from 'bun:test'
import { validateRuntimeEnvironment, laravelRuntimeEnvironment } from '../../../src/secrets/runtime-environment'
test('runtime settings reject control variables, malformed input and excessive values safely', () => {
  for (const value of [null, [], { APP_KEY: 'private' }, { WRENLY_AUTH_SECRET: 'private' }, { NODE_OPTIONS: 'private' }, { TOKEN: 'x'.repeat(8193) }, { TOKEN: 'private\0value' }])
    expect(() => validateRuntimeEnvironment(value)).toThrow('Saved runtime environment is invalid')
  expect(validateRuntimeEnvironment({ DATABASE_URL: 'private', MULTILINE: 'line1\nline2' })).toEqual({ DATABASE_URL: 'private', MULTILINE: 'line1\nline2' })
})
test('Laravel preserves supplied stable key and enforces production/debug policy', () => {
  const key = `base64:${Buffer.alloc(32).toString('base64')}`
  const input = { APP_DEBUG: 'true', APP_ENV: 'local', SESSION_DRIVER: 'redis' }
  expect(laravelRuntimeEnvironment(input, key)).toMatchObject({ APP_KEY: key, APP_ENV: 'production', APP_DEBUG: 'false', SESSION_DRIVER: 'redis' })
  expect(input.APP_DEBUG).toBe('true')
})
