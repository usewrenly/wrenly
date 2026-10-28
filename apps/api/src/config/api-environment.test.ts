import { expect, test } from 'bun:test'
import { parseApiEnvironment } from './api-environment'

const BASE = {
  WRENLY_DATABASE_URL: 'postgresql://user:password@localhost:65432/wrenly',
  WRENLY_AUTH_SECRET: 'private-value-not-for-logs',
  WRENLY_APP_URL: 'http://localhost:3002',
}

test('deployment encryption key is optional but validated without echoing its value', () => {
  expect(parseApiEnvironment(BASE).WRENLY_DEPLOY_ENCRYPTION_KEY).toBeUndefined()
  expect(parseApiEnvironment({ ...BASE, WRENLY_DEPLOY_ENCRYPTION_KEY: 'ab'.repeat(32) }).WRENLY_DEPLOY_ENCRYPTION_KEY)
    .toBe('ab'.repeat(32))
  const invalid = 'private-invalid-encryption-key'
  try {
    parseApiEnvironment({ ...BASE, WRENLY_DEPLOY_ENCRYPTION_KEY: invalid })
    throw new Error('Expected key validation failure')
  } catch (error) {
    expect(String(error)).toContain('WRENLY_DEPLOY_ENCRYPTION_KEY')
    expect(String(error)).not.toContain(invalid)
  }
})

test('validates listener defaults and explicit container overrides', () => {
  const environment = parseApiEnvironment(BASE)
  expect(environment.WRENLY_API_PORT).toBe(3002)
  expect(environment.WRENLY_API_HOST).toBe('127.0.0.1')
  expect(
    parseApiEnvironment({
      ...BASE,
      WRENLY_API_PORT: '3102',
      WRENLY_API_HOST: '0.0.0.0',
    }).WRENLY_API_PORT,
  ).toBe(3102)
})

test('reports missing variables and rejects invalid listener settings without echoing credentials', () => {
  expect(() => parseApiEnvironment({})).toThrow('WRENLY_DATABASE_URL')
  expect(() =>
    parseApiEnvironment({ ...BASE, WRENLY_API_PORT: 'invalid' }),
  ).toThrow('WRENLY_API_PORT')
  expect(() =>
    parseApiEnvironment({ ...BASE, WRENLY_SINGLE_USER_MODE: 'yes' }),
  ).toThrow('WRENLY_SINGLE_USER_MODE')
  try {
    parseApiEnvironment({ ...BASE, WRENLY_API_PORT: 999999 })
    throw new Error('Expected validation failure')
  } catch (error) {
    expect(String(error)).not.toContain(BASE.WRENLY_AUTH_SECRET)
    expect(String(error)).not.toContain('user:password')
  }
})

test('validates sandbox resource values before loading production services', () => {
  expect(parseApiEnvironment(BASE).WRENLY_SANDBOX_TIMEOUT_SECONDS).toBe(300)
  for (const [name, value] of [
    ['WRENLY_SANDBOX_MEMORY_LIMIT', 'garbage'],
    ['WRENLY_SANDBOX_MEMORY_LIMIT', '999999999999999999999g'],
    ['WRENLY_SANDBOX_CPU_LIMIT', '1e99'],
    ['WRENLY_SANDBOX_CPU_LIMIT', '-1'],
    ['WRENLY_SANDBOX_TIMEOUT_SECONDS', '0'],
    ['WRENLY_SANDBOX_TIMEOUT_SECONDS', '301'],
  ]) expect(() => parseApiEnvironment({ ...BASE, [name!]: value })).toThrow(name)
})


test('model generation timeout is configurable independently of sandbox execution', () => {
  expect(parseApiEnvironment(BASE).WRENLY_MODEL_TIMEOUT_SECONDS).toBe(180)
  const env = parseApiEnvironment({ ...BASE, WRENLY_MODEL_TIMEOUT_SECONDS: '300' })
  expect(env.WRENLY_MODEL_TIMEOUT_SECONDS).toBe(300)
  expect(env.WRENLY_SANDBOX_TIMEOUT_SECONDS).toBe(300)
  expect(() => parseApiEnvironment({ ...BASE, WRENLY_MODEL_TIMEOUT_SECONDS: '0' })).toThrow('WRENLY_MODEL_TIMEOUT_SECONDS')
})

test('preview activation validates ports, secret strength and separated origins', () => {
  const base = { ...BASE, WRENLY_AUTH_SECRET: 's'.repeat(32), WRENLY_PREVIEW_ENABLED: 'true' }
  expect(parseApiEnvironment(base).WRENLY_PREVIEW_GATEWAY_PORT).toBe(3003)
  expect(() => parseApiEnvironment({ ...base, WRENLY_AUTH_SECRET: 'short' })).toThrow('32')
  expect(() => parseApiEnvironment({ ...base, WRENLY_PREVIEW_BASE_URL: 'http://wrenly-preview.localhost:3000' })).toThrow('port')
  expect(() => parseApiEnvironment({ ...base, WRENLY_PREVIEW_BASE_URL: 'http://localhost:3003' })).toThrow('separate')
  expect(() => parseApiEnvironment({ ...base, WRENLY_WEB_URL: 'https://app.example.com', WRENLY_APP_URL: 'https://api.example.com', WRENLY_PREVIEW_BASE_URL: 'https://preview.example.com' })).toThrow('separate')
  expect(parseApiEnvironment({ ...base, WRENLY_WEB_URL: 'https://app.example.com', WRENLY_APP_URL: 'https://api.example.com', WRENLY_PREVIEW_BASE_URL: 'https://preview.example.net' }).WRENLY_PREVIEW_ENABLED).toBe('true')
})

test('publishing opt-in validates its full private target without echoing secrets', () => {
  expect(parseApiEnvironment(BASE).WRENLY_PUBLISHING_ENABLED).toBe('false')
  expect(() => parseApiEnvironment({ ...BASE, WRENLY_PUBLISHING_ENABLED: 'true' })).toThrow('WRENLY_REGISTRY_URL')
  const configured = { ...BASE, WRENLY_PUBLISHING_ENABLED: 'true', WRENLY_DEPLOY_ENCRYPTION_KEY: 'ab'.repeat(32),
    WRENLY_REGISTRY_URL: 'https://registry.example', WRENLY_REGISTRY_USERNAME: 'fixture', WRENLY_REGISTRY_PASSWORD: 'private-password',
    WRENLY_GIT_BASE_URL: 'https://git.example', WRENLY_GIT_TOKEN: 'private-token', WRENLY_COOLIFY_API_URL: 'https://coolify.example/api/v1',
    WRENLY_COOLIFY_API_KEY: 'private-key', WRENLY_COOLIFY_PROJECT_UUID: 'project', WRENLY_COOLIFY_SERVER_UUID: 'server' }
  expect(parseApiEnvironment(configured).WRENLY_PUBLISHING_ENABLED).toBe('true')
  for (const name of ['WRENLY_REGISTRY_URL', 'WRENLY_GIT_BASE_URL', 'WRENLY_COOLIFY_API_URL'])
    expect(() => parseApiEnvironment({ ...configured, [name]: 'http://remote.example' })).toThrow('HTTPS')
  expect(() => parseApiEnvironment({ ...configured, WRENLY_COOLIFY_PROJECT_UUID: '../project' })).toThrow('identifier')
  try { parseApiEnvironment({ ...configured, WRENLY_GIT_TOKEN: 'private-token\n' }) } catch (error) { expect(String(error)).not.toContain('private-token') }
})

test('Development databases require explicit opt-in and verified preview configuration', () => {
  expect(parseApiEnvironment(BASE).WRENLY_APP_DATABASES_ENABLED).toBe('false')
  expect(() => parseApiEnvironment({ ...BASE, WRENLY_APP_DATABASES_ENABLED: 'true' })).toThrow('WRENLY_PREVIEW_ENABLED')
  expect(parseApiEnvironment({ ...BASE, WRENLY_AUTH_SECRET: 'a'.repeat(64), WRENLY_PREVIEW_ENABLED: 'true', WRENLY_APP_DATABASES_ENABLED: 'true' }).WRENLY_APP_DATABASES_ENABLED).toBe('true')
})
