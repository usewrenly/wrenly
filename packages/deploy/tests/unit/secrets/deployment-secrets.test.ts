import { expect, test } from 'bun:test'
import { encryptDeploymentSecret, decryptDeploymentSecret } from '../../../src/secrets/deployment-secrets'

const KEY = 'ab'.repeat(32)
const PROJECT = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222'
const PURPOSE = 'laravel-app-key'

test('authenticated envelopes round-trip Unicode and use fresh nonces', () => {
  const secret = 'base64:private-key-🔑'
  const first = encryptDeploymentSecret(secret, KEY, PROJECT, PURPOSE)
  const second = encryptDeploymentSecret(secret, KEY, PROJECT, PURPOSE)
  expect(decryptDeploymentSecret(first, KEY, PROJECT, PURPOSE)).toBe(secret)
  expect(first.nonce).not.toBe(second.nonce)
  expect(first.ciphertext).not.toBe(second.ciphertext)
  expect(JSON.stringify(first)).not.toContain(secret)
})

test('rejects cross-project, cross-purpose and wrong-key decryption', () => {
  const envelope = encryptDeploymentSecret('private-key', KEY, PROJECT, PURPOSE)
  for (const decrypt of [
    () => decryptDeploymentSecret(envelope, KEY, OTHER_PROJECT, PURPOSE),
    () => decryptDeploymentSecret(envelope, KEY, PROJECT, 'git-deploy-private-key'),
    () => decryptDeploymentSecret(envelope, 'cd'.repeat(32), PROJECT, PURPOSE),
  ]) expect(decrypt).toThrow('could not be authenticated')
})

test('rejects tampered ciphertext, nonce, tag and invalid envelope formats', () => {
  const envelope = encryptDeploymentSecret('private-key', KEY, PROJECT, PURPOSE)
  for (const field of ['ciphertext', 'nonce', 'tag'] as const) {
    const bytes = Buffer.from(envelope[field], 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 1
    expect(() => decryptDeploymentSecret({ ...envelope, [field]: bytes.toString('base64') }, KEY, PROJECT, PURPOSE))
      .toThrow('could not be authenticated')
  }
  for (const invalid of [null, {}, { ...envelope, version: 2 }, { ...envelope, nonce: '!!!' },
    { ...envelope, tag: '' }, { ...envelope, ciphertext: 'a'.repeat(100_000) }])
    expect(() => decryptDeploymentSecret(invalid, KEY, PROJECT, PURPOSE)).toThrow('could not be authenticated')
})

test('validates key, scope and byte bounds without including secret input in errors', () => {
  for (const key of ['', 'secret-do-not-echo', 'ab'.repeat(31), 'zz'.repeat(32)]) {
    expect(() => encryptDeploymentSecret('private-secret', key, PROJECT, PURPOSE)).toThrow('Invalid deployment encryption key.')
  }
  expect(() => encryptDeploymentSecret('', KEY, PROJECT, PURPOSE)).toThrow('empty')
  expect(() => encryptDeploymentSecret('🔑'.repeat(20_000), KEY, PROJECT, PURPOSE)).toThrow('size limit')
  expect(() => encryptDeploymentSecret('private-secret', KEY, 'invalid-project', PURPOSE)).toThrow('Invalid deployment secret scope.')
  const bounded = 'a'.repeat(64 * 1024)
  expect(decryptDeploymentSecret(encryptDeploymentSecret(bounded, KEY, PROJECT, PURPOSE), KEY, PROJECT, PURPOSE)).toBe(bounded)
})
