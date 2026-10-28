import { expect, test } from 'bun:test'
import { prepareProjectSshKey } from '../../../src/secrets/ssh-keys'
test('OpenSSH project keys derive the same public identity from saved private material', async () => {
  const generated = await prepareProjectSshKey()
  const restored = await prepareProjectSshKey(generated.privateKey)
  expect(generated.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
  expect(restored.privateKey).toBe(generated.privateKey)
  expect(restored.publicKey.split(' ').slice(0, 2)).toEqual(generated.publicKey.split(' ').slice(0, 2))
  await expect(prepareProjectSshKey('private-invalid-value')).rejects.toThrow('Project SSH key could not be prepared')
})
