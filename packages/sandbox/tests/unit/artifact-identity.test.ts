// Invalid operation identities must fail before any Docker or registry side effect.
import { expect, test } from 'bun:test'
import { publishRuntimeArtifact } from '../../src/artifacts/artifact-registry'
import { cleanupUnacknowledgedArtifactImages } from '../../src/artifacts/runtime-artifact'

test('artifact promotion and image cleanup reject UUID-shaped junk before effects', async () => {
  let effects = 0
  for (const deploymentId of ['-'.repeat(36), 'a'.repeat(36)]) {
    await expect(publishRuntimeArtifact({ deploymentId, imageId: 'sha256:' + 'a'.repeat(64),
      origin: 'http://127.0.0.1:1', namespace: 'fixture', username: 'fixture', password: 'fixture',
      signal: new AbortController().signal, beforeEffect: async () => { effects++ },
    })).rejects.toThrow('configuration validation')
    await expect(cleanupUnacknowledgedArtifactImages(deploymentId)).rejects.toThrow('Invalid artifact cleanup identity')
  }
  expect(effects).toBe(0)
})
