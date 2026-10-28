// Promotes an owned runtime image to an operator-configured private registry.
// Require anonymous denial before upload and verify manifest bytes against the
// pushed digest and local image identity; a tag alone is never deployment identity.
import Docker from 'dockerode'
import { ARTIFACT_WORKSPACE_LABEL, ARTIFACT_WORKSPACE_VERSION } from './artifact-policy'
import { createHash } from 'node:crypto'
const REGISTRY_DEADLINE_MS = 300_000
const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: REGISTRY_DEADLINE_MS })
const MAX_PROGRESS_BYTES = 4 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MEDIA_TYPES = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'

/** Pushes an owned image only to an authenticated private registry and verifies immutable content. */
export async function publishRuntimeArtifact(input: {
  deploymentId: string; imageId: string; origin: string; namespace: string; username: string; password: string;
  signal: AbortSignal; beforeEffect: () => Promise<void>;
}): Promise<{ repository: string; digest: string }> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(REGISTRY_DEADLINE_MS)])
  let phase = 'configuration validation'
  let stream: NodeJS.ReadableStream | undefined
  const abort = (): void => { if (stream && 'destroy' in stream && typeof stream.destroy === 'function') stream.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const origin = new URL(input.origin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash ||
      !/^[a-z0-9_-]{1,100}$/.test(input.namespace) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.deploymentId) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.imageId) || !input.username || !input.password || /[\r\n:]/.test(input.username) || /[\r\n]/.test(input.password))
      throw new Error('Invalid registry configuration')
    phase = 'artifact identity'
    const image = await docker.getImage(input.imageId).inspect()
    if (image.Config.Labels?.['io.wrenly.deployment-id'] !== input.deploymentId ||
      image.Config.Labels['io.wrenly.artifact-role'] !== 'runtime' ||
      image.Config.Labels[ARTIFACT_WORKSPACE_LABEL] !== ARTIFACT_WORKSPACE_VERSION)
      throw new Error('Artifact ownership or workspace provenance mismatch. Rebuild from the selected revision.')
    phase = 'anonymous access check'
    const requireAnonymousDenial = async (url: string): Promise<void> => {
      const probe = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { Accept: MEDIA_TYPES } })
      void probe.body?.cancel().catch(() => {})
      if (probe.status !== 401 || !/^Basic\s/i.test(probe.headers.get('www-authenticate') ?? '')) throw new Error('Registry does not require private Basic authentication')
    }
    await requireAnonymousDenial(`${origin.origin}/v2/`)
    const repositoryPath = `${input.namespace}/deployment-${input.deploymentId}`
    const repository = `${origin.host}/${repositoryPath}`
    await requireAnonymousDenial(`${origin.origin}/v2/${repositoryPath}/manifests/artifact`)
    await input.beforeEffect(); signal.throwIfAborted()
    await docker.getImage(input.imageId).tag({ repo: repository, tag: 'artifact', abortSignal: signal })
    await input.beforeEffect(); signal.throwIfAborted()
    phase = 'registry push'
    stream = await docker.getImage(repository).push({ tag: 'artifact', abortSignal: signal,
      authconfig: { username: input.username, password: input.password, serveraddress: origin.host } })
    signal.throwIfAborted()
    let total = 0; let buffer = ''; let digest: string | undefined
    const consume = (line: string): void => {
      if (!line.trim()) return
      const event: unknown = JSON.parse(line)
      if (!event || typeof event !== 'object') throw new Error('Invalid progress')
      if ('error' in event || 'errorDetail' in event) throw new Error('Registry push failed')
      if ('aux' in event && event.aux && typeof event.aux === 'object' && 'Digest' in event.aux && typeof event.aux.Digest === 'string') digest = event.aux.Digest
      if ('status' in event && typeof event.status === 'string') {
        const match = /^[^\r\n]{1,100}: digest: (sha256:[a-f0-9]{64}) size: \d+$/.exec(event.status)
        if (match) digest = match[1]
      }
    }
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      signal.throwIfAborted(); total += chunk.length
      if (total > MAX_PROGRESS_BYTES) throw new Error('Registry progress exceeded limit')
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1)
      }
    }
    consume(buffer)
    phase = 'push digest verification'
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Missing immutable digest')
    phase = 'registry manifest verification'
    const readManifest = async (reference: string): Promise<unknown> => {
      if (!/^sha256:[a-f0-9]{64}$/.test(reference)) throw new Error('Invalid manifest reference')
      const response = await fetch(`${origin.origin}/v2/${repositoryPath}/manifests/${reference}`, {
        redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { Authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}`, Accept: MEDIA_TYPES },
      })
      if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('Manifest unavailable') }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > MAX_MANIFEST_BYTES) throw new Error('Manifest too large'); chunks.push(chunk.value) }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      const manifest = Buffer.concat(chunks)
      if (`sha256:${createHash('sha256').update(manifest).digest('hex')}` !== reference) throw new Error('Manifest digest mismatch')
      return JSON.parse(manifest.toString('utf8')) as unknown
    }
    let parsed = await readManifest(digest)
    // Docker's containerd image store identifies images by their OCI descriptor,
    // while the classic store uses the config digest. Verify the store's own
    // immutable identity rather than assuming both identifiers mean the same thing.
    const metadata = image as unknown as { Descriptor?: { digest?: unknown } }
    const descriptorDigest = metadata.Descriptor?.digest
    if (descriptorDigest !== undefined && (descriptorDigest !== input.imageId || digest !== descriptorDigest))
      throw new Error('Published manifest differs from the local artifact descriptor')
    // Containerd-backed Docker may wrap a single native image in an OCI index.
    if (parsed && typeof parsed === 'object' && 'manifests' in parsed) {
      if (!Array.isArray(parsed.manifests) || parsed.manifests.length !== 1) throw new Error('Unsupported multi-platform artifact')
      const descriptor: unknown = parsed.manifests[0]
      if (!descriptor || typeof descriptor !== 'object' || !('digest' in descriptor) || typeof descriptor.digest !== 'string' ||
        !('platform' in descriptor) || !descriptor.platform || typeof descriptor.platform !== 'object' ||
        !('os' in descriptor.platform) || descriptor.platform.os !== image.Os || !('architecture' in descriptor.platform) || descriptor.platform.architecture !== image.Architecture)
        throw new Error('Artifact platform mismatch')
      parsed = await readManifest(descriptor.digest)
    }
    phase = 'manifest image identity'
    if (!parsed || typeof parsed !== 'object' || !('config' in parsed) || !parsed.config || typeof parsed.config !== 'object' ||
      !('digest' in parsed.config) || (descriptorDigest === undefined && parsed.config.digest !== input.imageId)) throw new Error('Manifest refers to a different artifact')
    phase = 'published anonymous access check'
    await requireAnonymousDenial(`${origin.origin}/v2/${repositoryPath}/manifests/${digest}`)
    return { repository, digest }
  } catch { throw new Error(`Private runtime artifact ${phase} could not be confirmed. Reconcile the registry before retrying.`) }
  finally { signal.removeEventListener('abort', abort); if (stream && 'destroy' in stream && typeof stream.destroy === 'function') stream.destroy() }
}
