// Packages the selected source in a per-deployment Docker workspace.
// Installation disables hooks; compilation is offline; only trusted copy commands
// assemble the image. No runtime credentials are available during preparation.
import Docker from 'dockerode'
import { ARTIFACT_WORKSPACE_LABEL, ARTIFACT_WORKSPACE_VERSION } from './artifact-policy'
import { LARAVEL_RUNTIME_IMAGE, LARAVEL_INSTALL_COMMAND, LARAVEL_BUILD_COMMAND, LARAVEL_COMPILE_COMMAND, LARAVEL_START_COMMAND, laravelValidationEnvironment, validateLaravelSource } from '../source-policy/laravel-runtime'
import { ARTIFACT_WATCHDOG_SOURCE } from './artifact-watchdog'
import { mkdtemp, mkdir, writeFile, rm, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateFilePaths } from '../source-policy/file-paths'
import { readAppDatabaseManifest } from '../databases/database-manifest'
import { validateNextjsStyling } from '../source-policy/nextjs-styling'
const TIMEOUT_MS = 300_000
const MAX_COMPILER_LOG_BYTES = 16 * 1024
// Keep only a bounded local compiler log; no runtime credentials enter preparation.
const COMPILER_LOG_DISK_LIMIT = '128k'
const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: TIMEOUT_MS })
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const LABEL = 'io.wrenly.deployment-id'
const ROLE_LABEL = 'io.wrenly.artifact-role'
/** Base messages expose only a fixed stage; compiler diagnostics use the explicit project-only subtype. */
export class RuntimeArtifactError extends Error {
  constructor(public readonly phase: string) {
    super(`Sandbox runtime artifact ${phase} failed. No deployment was started.`)
    this.name = 'RuntimeArtifactError'
  }
}
/** An observed compiler exit, usable only after this preparation's finally cleanup succeeds. */
export class RuntimeArtifactCompilationError extends RuntimeArtifactError {
  constructor(public readonly operationId: string, public readonly exitCode: number, public readonly output: string) {
    super('offline compilation')
    this.name = 'RuntimeArtifactCompilationError'
  }
}

/** Docker's stdout/stderr frames are data, never commands; keep only the final diagnostic tail. */
function compilerOutput(buffer: Buffer): string {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4)
    if (buffer[offset]! > 2 || offset + 8 + size > buffer.length) throw new Error('Invalid compiler output framing')
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  if (offset !== buffer.length) throw new Error('Incomplete compiler output')
  return Buffer.concat(chunks).subarray(-MAX_COMPILER_LOG_BYTES).toString('utf8').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}
export interface RuntimeArtifact { imageId: string; baseImageId: string; sizeBytes: number }

/** Builds a Next.js or Laravel runtime image offline after installation; caller owns the retained image. */
interface RuntimeArtifactInput { deploymentId: string; stack?: string; files: Array<{ path: string; content: string }>; signal: AbortSignal; beforeEffect: () => Promise<void> }
/** Stateless preparation retains its offline HTTP checks and cannot bypass database validation. */
export function buildRuntimeArtifact(input: RuntimeArtifactInput): Promise<RuntimeArtifact> {
  return prepareRuntimeArtifact(input);
}
/** Preparation only: matching saved migrations are required; no database, credentials or HTTP success is implied. */
export function prepareDatabaseValidationArtifact(input: RuntimeArtifactInput & { stack: 'nextjs' | 'laravel'; migrationDigest: string }): Promise<RuntimeArtifact> {
  return prepareRuntimeArtifact(input, input.migrationDigest);
}
async function prepareRuntimeArtifact(input: RuntimeArtifactInput, databaseMigrationDigest?: string): Promise<RuntimeArtifact> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.deploymentId) ||
    !input.files.length || input.files.length > 1000 || Buffer.byteLength(JSON.stringify(input.files)) > MAX_SOURCE_BYTES)
    throw new Error('Runtime artifact source is invalid or oversized.')
  const laravel = input.stack === 'laravel'
  if (input.stack && !['nextjs', 'laravel'].includes(input.stack)) throw new Error('Unsupported runtime artifact stack.')
  validateFilePaths(input.files)
  const database = readAppDatabaseManifest(input.files, laravel ? 'laravel' : 'nextjs')
  if (databaseMigrationDigest === undefined ? database !== null : !database || database.digest !== databaseMigrationDigest)
    throw new RuntimeArtifactError('database preparation requires the exact reviewed migration path')
  if (laravel) validateLaravelSource(input.files); else validateNextjsStyling(input.files)
  if (input.files.some(file => file.path.endsWith('public/.well-known/wrenly-deployment'))) throw new Error('Runtime artifact source uses a reserved deployment marker path.')
  if (input.files.some(file => file.path.split('/').some(part => part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.env') && part !== '.env.example')))
    throw new Error('Runtime artifacts cannot contain private environment or Git metadata files.')
  const deadlineAt = Date.now() + TIMEOUT_MS
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])
  let directory: string | undefined
  let volume: Docker.Volume | undefined
  let retainedImage: string | undefined
  let phase = 'setup'
  const containers: Docker.Container[] = []
  const labels = { [LABEL]: input.deploymentId, [ROLE_LABEL]: 'preparation' }
  try {
    const base = await docker.getImage(laravel ? LARAVEL_RUNTIME_IMAGE : 'oven/bun:alpine').inspect()
    const baseImageId = base.Id
    directory = await mkdtemp(join(tmpdir(), `wrenly-artifact-${input.deploymentId}-`))
    const watchdog = join(directory, 'watchdog.js')
    await writeFile(watchdog, ARTIFACT_WATCHDOG_SOURCE, { mode: 0o644, flag: 'wx' })
    const source = join(directory, 'source')
    await mkdir(source, { mode: 0o755 })
    for (const file of input.files) {
      const target = join(source, file.path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, file.content, { mode: 0o644, flag: 'wx' })
    }
    await input.beforeEffect(); signal.throwIfAborted()
    const existingVolumes = await docker.listVolumes()
    if (existingVolumes.Volumes?.some(row => row.Name === `wrenly-artifact-${input.deploymentId}`))
      throw new Error('An existing artifact workspace requires reconciliation.')
    // Dockerode's installed runtime/types disagree about createVolume's return.
    // Resolve our explicit name and verify it rather than reading that response.
    const name = `wrenly-artifact-${input.deploymentId}`
    await docker.createVolume({ Name: name, Labels: labels })
    const createdVolume = docker.getVolume(name)
    const volumeInfo = await createdVolume.inspect()
    if (volumeInfo.Name !== name || Object.entries(labels).some(([key, value]) => volumeInfo.Labels?.[key] !== value))
      throw new Error('Artifact workspace ownership could not be verified.')
    volume = createdVolume
    const run = async (command: string[], network: 'none' | 'bridge', binds: string[], root = false, ownFiles = false): Promise<Docker.Container> => {
      await input.beforeEffect(); signal.throwIfAborted()
      const container = await docker.createContainer({ Image: baseImageId, WorkingDir: root ? '/app' : '/', Cmd: root ? command : ['bun', '/wrenly-artifact-watchdog.js', String(Math.max(1, deadlineAt - Date.now())), ...command], Labels: labels,
        User: '0:0', Env: laravel && !root ? laravelValidationEnvironment() : ['NEXT_TELEMETRY_DISABLED=1', `NODE_ENV=${network === 'bridge' ? 'development' : 'production'}`, 'HOME=/tmp'],
        HostConfig: { Binds: root ? binds : [...binds, `${watchdog}:/wrenly-artifact-watchdog.js:ro`], NetworkMode: network, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3,
          NanoCpus: 2_000_000_000, PidsLimit: 256, CapDrop: ['ALL'], CapAdd: root ? (ownFiles ? ['CHOWN'] : []) : ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges:true'], LogConfig: databaseMigrationDigest !== undefined && phase === 'offline compilation' ? { Type: 'json-file', Config: { 'max-size': COMPILER_LOG_DISK_LIMIT, 'max-file': '1' } } : { Type: 'none', Config: {} } } })
      containers.push(container)
      const abort = (): void => { void container.kill().catch(() => {}) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted(); await container.start(); if (signal.aborted) abort()
        const result = await container.wait({ abortSignal: signal })
        signal.throwIfAborted()
        if (result.StatusCode !== 0) {
          // Guardian timeouts/signals and transport failures remain uncertain, never repairable evidence.
          if (databaseMigrationDigest !== undefined && phase === 'offline compilation' &&
            Number.isInteger(result.StatusCode) && result.StatusCode > 0 && result.StatusCode < 124) {
            const logs = await container.logs({ stdout: true, stderr: true, follow: false, tail: 200, abortSignal: signal })
            signal.throwIfAborted()
            if (!Buffer.isBuffer(logs)) throw new Error('Compiler output could not be read')
            throw new RuntimeArtifactCompilationError(input.deploymentId, result.StatusCode, compilerOutput(logs))
          }
          throw new Error('Runtime artifact container operation failed.')
        }
        return container
      } finally { signal.removeEventListener('abort', abort) }
    }
    const mount = `${volume.name}:/app`
    phase = 'source copy'
    await run(['sh', '-c', 'cp -R /source/. /app/ && chmod -R a+rwX /app'], 'none', [`${source}:/source:ro`, mount], true)
    phase = 'dependency installation'
    await run(laravel ? LARAVEL_INSTALL_COMMAND : ['bun', 'install', '--ignore-scripts', '--cache-dir', '/tmp/bun-cache'], 'bridge', [mount])
    phase = 'offline compilation'
    await run(laravel ? database ? LARAVEL_COMPILE_COMMAND : LARAVEL_BUILD_COMMAND : ['bun', 'run', 'build'], 'none', [mount])
    phase = 'deployment identity marker'
    await run(['sh', '-c', `mkdir -p /app/public/.well-known && printf '%s' '${input.deploymentId}' > /app/public/.well-known/wrenly-deployment`], 'none', [mount])
    // du executes trusted tooling; no generated script participates in the size gate.
    await run(['sh', '-c', `test "$(du -sk /app | cut -f1)" -le ${MAX_ARTIFACT_BYTES / 1024}`], 'none', [mount])
    phase = 'image packaging'
    // Blade updates compiled-file timestamps; write permission alone does not allow
    // a different owner to set explicit mtimes. CHOWN belongs only to trusted copy.
    const packed = await run(['sh', '-c', 'mkdir -p /app && cp -R /source/. /app/ && chmod -R a+rwX /app' +
      (laravel ? ' && rm -f /app/.env /app/.env.* /app/bootstrap/cache/config.php /app/bootstrap/cache/routes-*.php && chown -Rh 1000:1000 /app' : '')], 'none', [`${volume.name}:/source:ro`], true, laravel)
    await input.beforeEffect(); signal.throwIfAborted()
    phase = 'image commit'
    const committed = await packed.commit({ changes: [
      'USER 1000:1000', 'WORKDIR /app',
      laravel ? `CMD ${JSON.stringify(LARAVEL_START_COMMAND)}` : 'CMD ["bun","node_modules/next/dist/bin/next","start","--hostname","0.0.0.0","--port","3000"]',
      laravel ? 'ENV APP_ENV=production APP_DEBUG=false HOME=/tmp XDG_CONFIG_HOME=/tmp/config XDG_DATA_HOME=/tmp/data' : 'ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOME=/tmp', 'EXPOSE 3000',
      `LABEL ${ROLE_LABEL}=runtime`,
      `LABEL ${ARTIFACT_WORKSPACE_LABEL}=${ARTIFACT_WORKSPACE_VERSION}`,
    ], abortSignal: signal })
    retainedImage = committed.Id
    const image = await docker.getImage(committed.Id).inspect()
    if (image.Size > MAX_ARTIFACT_BYTES || image.Config.Labels?.[LABEL] !== input.deploymentId ||
      image.Config.Labels[ARTIFACT_WORKSPACE_LABEL] !== ARTIFACT_WORKSPACE_VERSION)
      throw new Error('Runtime artifact image exceeds its size limit or identity changed.')
    signal.throwIfAborted()
    return { imageId: committed.Id, baseImageId, sizeBytes: image.Size }
  } catch (error) {
    if (error instanceof RuntimeArtifactCompilationError && !signal.aborted && !retainedImage) throw error
    if (retainedImage) await docker.getImage(retainedImage).remove({ force: true }).catch(() => {})
    throw new RuntimeArtifactError(phase)
  } finally {
    // Do not remove a mounted workspace until every owned container is gone.
    const removed = await Promise.allSettled(containers.map(container => container.remove({ force: true, v: true })))
    // Cleanup uncertainty must override success/failure: never promote an image with live preparation containers.
    // eslint-disable-next-line no-unsafe-finally
    if (removed.some(result => result.status === 'rejected')) throw new Error('Runtime artifact cleanup could not be confirmed; reconcile owned Docker resources.')
    if (volume) await volume.remove()
    if (directory) await rm(directory, { recursive: true, force: true })
    signal.throwIfAborted()
  }
}

/** Removes only Docker preparation resources labelled for this operation after executor quiescence. */
export async function cleanupRuntimeArtifactPreparation(deploymentId: string, assertHeld: () => Promise<void> = async () => {}): Promise<void> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(deploymentId)) throw new Error('Invalid artifact cleanup identity.')
  try {
    await assertHeld()
    const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABEL}=${deploymentId}`, `${ROLE_LABEL}=preparation`] }) })
    for (const row of containers) { await assertHeld(); await docker.getContainer(row.Id).remove({ force: true, v: true }) }
    const volumes = await docker.listVolumes({ filters: JSON.stringify({ label: [`${LABEL}=${deploymentId}`, `${ROLE_LABEL}=preparation`] }) })
    for (const row of volumes.Volumes ?? []) {
      await assertHeld()
      const volume = docker.getVolume(row.Name)
      const info = await volume.inspect()
      if (info.Name !== row.Name || info.Labels?.[LABEL] !== deploymentId || info.Labels[ROLE_LABEL] !== 'preparation')
        throw new Error('Artifact workspace ownership changed.')
      await assertHeld(); await volume.remove()
    }
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(`wrenly-artifact-${deploymentId}-`)) continue
      const path = join(tmpdir(), name)
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('Unsafe artifact workspace.')
      await assertHeld(); await rm(path, { recursive: true, force: true })
    }
  } catch { throw new Error('Owned runtime artifact preparation cleanup could not be confirmed.') }
}

/** Removes unacknowledged images only after operator-fenced recovery, never runtime containers. */
export async function cleanupUnacknowledgedArtifactImages(deploymentId: string): Promise<void> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deploymentId)) throw new Error('Invalid artifact cleanup identity.')
  try {
    const images = await docker.listImages({ filters: JSON.stringify({ label: [`${LABEL}=${deploymentId}`, `${ROLE_LABEL}=runtime`] }) })
    for (const image of images) await docker.getImage(image.Id).remove({ force: false })
  } catch { throw new Error('Unacknowledged artifact cleanup could not be confirmed. Inspect its Docker references before reconciliation.') }
}

/** Fails activation if the trusted local Docker/base-image prerequisites are absent. */
export async function verifyRuntimeArtifactHost(): Promise<void> {
  try {
    await docker.ping()
    await docker.getImage('oven/bun:alpine').inspect()
  } catch { throw new Error('Publishing requires the local Docker socket and oven/bun:alpine image. Pull the trusted base image before activation.') }
}
