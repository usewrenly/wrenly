import { expect, test } from 'bun:test'
import { previewNetworkOptions } from '../src/previews/network'

test('preview networking never falls back to ordinary bridge routing', () => {
  const options = previewNetworkOptions(crypto.randomUUID())
  expect(options.Internal).toBe(true)
  expect(options.EnableIPv6).toBe(false)
  expect(options.Options?.['com.docker.network.bridge.gateway_mode_ipv4']).toBe('isolated')
  expect(() => previewNetworkOptions('../escape')).toThrow('identity')
})

test('unsupported or unidentified Docker daemons fail closed', async () => {
  const { assertPreviewDockerSupport } = await import('../src/previews/network')
  expect(() => assertPreviewDockerSupport('29.8.0')).not.toThrow()
  expect(() => assertPreviewDockerSupport('27.5.1')).toThrow('28 or newer')
  expect(() => assertPreviewDockerSupport('unknown')).toThrow('28 or newer')
})
