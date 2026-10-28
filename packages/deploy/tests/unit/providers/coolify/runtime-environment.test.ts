import { expect, test } from 'bun:test'
import { deliverRuntimeEnvironment } from '../../../../src/providers/coolify/runtime-environment'
import type { DeploymentProviderClient } from '../../../../src/http/provider-client'
const signal = new AbortController().signal
test('runtime secrets are delivered literally with build-time injection disabled and no returned values', async () => {
  const provider: DeploymentProviderClient = { request: async (method, endpoint, body) => {
    expect(method).toBe('PATCH'); expect(endpoint).toBe('/api/v1/applications/application/envs/bulk')
    expect(body).toEqual({ data: [{ key: 'APP_KEY', value: 'private-key', is_preview: false, is_literal: true,
      is_multiline: false, is_shown_once: true, is_runtime: true, is_buildtime: false }] })
    return [{ key: 'APP_KEY', is_preview: false, is_literal: true, is_runtime: true, is_buildtime: false, value: 'private-key' }]
  } }
  expect(await deliverRuntimeEnvironment(provider, 'application', { APP_KEY: 'private-key' }, signal)).toBeUndefined()
  await expect(deliverRuntimeEnvironment({ request: async () => [{ key: 'APP_KEY', is_runtime: true, is_buildtime: true }] },
    'application', { APP_KEY: 'private-key' }, signal)).rejects.toThrow('invalid_response')
})
