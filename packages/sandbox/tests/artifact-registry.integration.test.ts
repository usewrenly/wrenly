// Disposable Basic-auth registry, trusted tiny image fixture, no operator credentials.
import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishRuntimeArtifact } from '../src/artifacts/artifact-registry'
import { ARTIFACT_WORKSPACE_LABEL, ARTIFACT_WORKSPACE_VERSION } from '../src/artifacts/artifact-policy'
const integration = process.env.WRENLY_TEST_ARTIFACT_REGISTRY === 'true' ? describe : describe.skip
integration('private immutable artifact registry', () => {
  test('requires authentication, publishes exact image content and verifies digest/config identity', async () => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const directory = await mkdtemp(join(tmpdir(), 'wrenly-registry-fixture-'))
    let registry: Docker.Container | undefined; let source: Docker.Container | undefined; let imageId: string | undefined
    let tagged: string | undefined; let legacyImageId: string | undefined
    try {
      await writeFile(join(directory, 'htpasswd'), `fixture:${await Bun.password.hash('fixture-password', { algorithm: 'bcrypt', cost: 4 })}\n`, { mode: 0o644 })
      registry = await docker.createContainer({ Image: 'registry:3', Env: ['REGISTRY_AUTH=htpasswd', 'REGISTRY_AUTH_HTPASSWD_REALM=Wrenly Test', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd'],
        HostConfig: { Binds: [`${directory}/htpasswd:/auth/htpasswd:ro`], PortBindings: { '5000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }, Memory: 256 * 1024 ** 2, NanoCpus: 1_000_000_000 },
        ExposedPorts: { '5000/tcp': {} } })
      await registry.start()
      const binding = (await registry.inspect()).NetworkSettings.Ports['5000/tcp']?.[0]
      if (!binding?.HostPort) throw new Error('Registry fixture port missing')
      const origin = `http://127.0.0.1:${binding.HostPort}`
      for (let count = 0; count < 40; count++) { try { const response = await fetch(origin + '/v2/'); void response.body?.cancel(); if (response.status === 401) break } catch {} await Bun.sleep(100) }
      const deploymentId = crypto.randomUUID()
      source = await docker.createContainer({ Image: 'oven/bun:alpine', Cmd: ['true'], Labels: { 'io.wrenly.deployment-id': deploymentId, 'io.wrenly.artifact-role': 'runtime' }, HostConfig: { NetworkMode: 'none' } })
      await source.start(); await source.wait()
      legacyImageId = (await source.commit({ changes: ['USER 1000:1000'] })).Id
      await expect(publishRuntimeArtifact({ deploymentId, imageId: legacyImageId!, origin, namespace: 'wrenly',
        username: 'fixture', password: 'fixture-password', signal: new AbortController().signal,
        beforeEffect: async () => { throw new Error('Legacy artifact must not cause mutations') } })).rejects.toThrow('artifact identity')
      imageId = (await source.commit({ changes: ['USER 1000:1000', `LABEL ${ARTIFACT_WORKSPACE_LABEL}=${ARTIFACT_WORKSPACE_VERSION}`] })).Id
      const artifact = await publishRuntimeArtifact({ deploymentId, imageId: imageId!, origin, namespace: 'wrenly', username: 'fixture', password: 'fixture-password',
        signal: new AbortController().signal, beforeEffect: async () => {} })
      tagged = artifact.repository + ':artifact'
      expect(artifact.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
      const publicRegistry = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('{}') })
      let effects = 0
      try {
        await expect(publishRuntimeArtifact({ deploymentId, imageId: imageId!, origin: publicRegistry.url.origin, namespace: 'wrenly',
          username: 'fixture', password: 'fixture-password', signal: new AbortController().signal, beforeEffect: async () => { effects++ } })).rejects.toThrow('anonymous access check')
        expect(effects).toBe(0)
      } finally { await publicRegistry.stop(true) }
      const anonymous = await fetch(`${origin}/v2/wrenly/deployment-${deploymentId}/manifests/${artifact.digest}`)
      expect(anonymous.status).toBe(401); void anonymous.body?.cancel()
      await expect(publishRuntimeArtifact({ deploymentId: crypto.randomUUID(), imageId: imageId!, origin, namespace: 'wrenly', username: 'fixture', password: 'fixture-password', signal: new AbortController().signal, beforeEffect: async () => {} })).rejects.toThrow('could not be confirmed')
    } finally {
      await registry?.remove({ force: true, v: true }); await source?.remove({ force: true, v: true })
      if (tagged) await docker.getImage(tagged).remove({ force: true })
      if (imageId) await docker.getImage(imageId).remove({ force: true }).catch(() => {})
      if (legacyImageId) await docker.getImage(legacyImageId).remove({ force: true }).catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
