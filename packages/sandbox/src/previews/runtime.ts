// Prepares saved source, starts its isolated app and trusted ingress, then proves HTTP readiness.
// Retained resources belong to one preview/build/claim; uncertain cleanup requires recovery.
import Docker from 'dockerode'
import { LARAVEL_RUNTIME_IMAGE, LARAVEL_INSTALL_COMMAND, LARAVEL_BUILD_COMMAND, LARAVEL_START_COMMAND, laravelValidationEnvironment, validateLaravelSource } from '../source-policy/laravel-runtime'
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { Writable, type Duplex } from 'stream'
import { StringDecoder } from 'string_decoder'
import { validateFilePaths } from '../source-policy/file-paths'
import { validateNextjsStyling, NextjsStylingError } from '../source-policy/nextjs-styling'
import { assertPreviewDockerSupport, previewNetworkOptions } from './network'
import { previewResourceLabels, resolvePreviewAppTarget, type PreviewResourceIdentity } from './target'

const IMAGE = 'oven/bun:alpine'
const MAX_PREPARATION_MS = 300_000
const MAX_READINESS_MS = 60_000
const MAX_LOG_CHARS = 256_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const POLL_MS = 100
const MAX_REDIRECTS = 5
const INGRESS_PORT = '8080/tcp'
const BASE_DIRECTORY = join(tmpdir(), 'wrenly-preview')
const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 10_000 })
const APP_LIMITS: Docker.HostConfig = { Memory: 2 * 1024 ** 3, NanoCpus: 2_000_000_000, PidsLimit: 256,
  Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1' },
  CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true,
  Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=128m' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } } }
const ENVIRONMENT = ['NODE_ENV=production', 'NEXT_TELEMETRY_DISABLED=1', 'HOSTNAME=0.0.0.0', 'PORT=3000', 'HOME=/tmp']

export interface PreviewRuntimeResources {
  appContainerId: string
  ingressContainerId: string
  appNetworkId: string
  ingressNetworkId: string
}
export interface PreviewRuntimeInput {
  identity: PreviewResourceIdentity
  stack?: string
  files: Array<{ path: string; content: string }>
  ingressBundle: Uint8Array
  ingress: { previewOrigin: string; controlOrigin: string; capability: string; blockedCookieNames: string[] }
  beforeEffect?: () => Promise<void>
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  onStarted?: (resources: PreviewRuntimeResources, preparation: { imageId: string; lockfileSha256: string | null }) => Promise<void>
  preparationTimeoutMs?: number
  readinessTimeoutMs?: number
}
export interface PreviewRuntimeResult {
  resources: PreviewRuntimeResources
  ingressUrl: string
  imageId: string
  lockfileSha256: string | null
  output: string
}
export class PreviewRuntimeError extends Error {
  constructor(public readonly phase: string, public readonly output = '') { super(`Preview ${phase} failed. Review preview diagnostics.`); this.name = 'PreviewRuntimeError' }
}
export class PreviewCleanupError extends Error {
  constructor() { super('Preview cleanup could not be confirmed. Recovery is required.'); this.name = 'PreviewCleanupError' }
}
function directory(identity: PreviewResourceIdentity): string {
  previewResourceLabels(identity, 'app')
  return join(BASE_DIRECTORY, `${identity.previewId}-${identity.projectId}-${identity.buildId}-${identity.claimToken}`)
}
/** Both preview adapters use this private, claim-bound directory so the same fenced cleanup can remove it. */
export async function createPreviewRuntimeDirectory(identity: PreviewResourceIdentity): Promise<string> {
  const parent = directory(identity)
  await secureBase(true)
  await mkdir(parent, { recursive: false, mode: 0o700 })
  return parent
}
async function secureBase(create: boolean): Promise<void> {
  if (create) await mkdir(BASE_DIRECTORY, { recursive: true, mode: 0o700 })
  try {
    const info = await lstat(BASE_DIRECTORY)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new PreviewCleanupError()
  } catch (error) {
    if (!create && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}
function volumeName(identity: PreviewResourceIdentity): string { return `wrenly-preview-${identity.previewId}-${identity.claimToken}` }
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw new PreviewRuntimeError('execution aborted or deadline') }
function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
}
function owned(labels: Record<string, string> | undefined, identity: PreviewResourceIdentity): boolean {
  const expected = previewResourceLabels(identity, 'app')
  delete expected['io.wrenly.preview-role']
  return Object.entries(expected).every(([key, value]) => labels?.[key] === value)
}

/** Call only after the original executor is quiescent. Claim labels discover partial resources;
 * a supplied cleanup fence is awaited before each deletion so lease loss preserves the remainder.
 */
export async function cleanupPreviewRuntime(identity: PreviewResourceIdentity, assertHeld?: () => Promise<void>): Promise<void> {
  const parent = directory(identity)
  const labels = previewResourceLabels(identity, 'app')
  delete labels['io.wrenly.preview-role']
  const filters = JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) })
  try {
    await assertHeld?.()
    await secureBase(false)
    for (const item of await docker.listContainers({ all: true, filters })) {
      const container = docker.getContainer(item.Id)
      try {
        if (!owned((await container.inspect()).Config.Labels, identity)) throw new PreviewCleanupError()
        await assertHeld?.()
        await container.remove({ force: true, v: true })
      } catch (error) { if (!absent(error)) throw error }
    }
    await assertHeld?.()
    for (const item of await docker.listNetworks({ filters })) {
      const network = docker.getNetwork(item.Id)
      try {
        if (!owned((await network.inspect()).Labels, identity)) throw new PreviewCleanupError()
        await assertHeld?.()
        await network.remove()
      } catch (error) { if (!absent(error)) throw error }
    }
    await assertHeld?.()
    for (const item of (await docker.listVolumes({ filters })).Volumes ?? []) {
      const volume = docker.getVolume(item.Name)
      try {
        if (!owned((await volume.inspect()).Labels, identity)) throw new PreviewCleanupError()
        await assertHeld?.()
        await volume.remove()
      } catch (error) { if (!absent(error)) throw error }
    }
    await assertHeld?.()
    await rm(parent, { recursive: true, force: true })
  } catch { throw new PreviewCleanupError() }
}

async function removePreparationContainer(container: Docker.Container): Promise<void> {
  try { await container.remove({ force: true, v: true }) }
  catch (error) { if (!absent(error)) throw new PreviewCleanupError() }
}

async function runPreparation(command: string[], identity: PreviewResourceIdentity, image: string,
  binds: string[], network: 'none' | 'bridge', signal: AbortSignal, append: (chunk: string) => void, root = false, beforeEffect?: () => Promise<void>, environment = ENVIRONMENT): Promise<void> {
  let container: Docker.Container | undefined
  let attached: Duplex | undefined
  const stdout = new StringDecoder('utf8')
  const stderr = new StringDecoder('utf8')
  const sink = (decoder: StringDecoder): Writable => new Writable({ write(chunk: Buffer, _encoding, callback) {
    try { append(decoder.write(chunk)); callback() } catch (error) { callback(error instanceof Error ? error : new Error('Preview logging failed.')) }
  } })
  let outputFailure: unknown
  const out = sink(stdout); const err = sink(stderr)
  out.on('error', (error: unknown) => { outputFailure = error })
  err.on('error', (error: unknown) => { outputFailure = error })
  try {
    checkAbort(signal)
    await beforeEffect?.(); checkAbort(signal)
    container = await docker.createContainer({ Image: image, Cmd: command, WorkingDir: '/app', Env: command[1] === 'install' ? environment.map(value => value === 'NODE_ENV=production' ? 'NODE_ENV=development' : value) : environment,
      User: root ? '0:0' : '65534:65534', Labels: previewResourceLabels(identity, 'prepare'),
      AttachStdout: true, AttachStderr: true, HostConfig: { ...APP_LIMITS, Binds: binds, NetworkMode: network } })
    checkAbort(signal)
    attached = await container.attach({ stream: true, stdout: true, stderr: true }) as Duplex
    if ('setTimeout' in attached && typeof attached.setTimeout === 'function') attached.setTimeout(0)
    const drained = new Promise<void>((resolve, reject) => { attached!.once('end', resolve); attached!.once('error', reject) })
    void drained.catch(() => {})
    container.modem.demuxStream(attached, out, err)
    await beforeEffect?.(); checkAbort(signal)
    await container.start()
    let exitCode = 0
    while (true) {
      checkAbort(signal)
      if (outputFailure) throw outputFailure
      const info = await container.inspect()
      if (!info.State.Running) {
        exitCode = info.State.ExitCode
        break
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
    // Socket reads can outlive a stopped container; the same operation signal owns the drain.
    await Promise.race([drained, new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new PreviewRuntimeError('execution aborted or deadline'))
      signal.addEventListener('abort', onAbort, { once: true })
      void drained.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {})
      if (signal.aborted) onAbort()
    })])
    append(stdout.end()); append(stderr.end())
    if (outputFailure) throw outputFailure
    if (exitCode !== 0) throw new PreviewRuntimeError('preparation command')
  } finally {
    attached?.destroy()
    if (container) await removePreparationContainer(container)
  }
}

/** Readiness goes through trusted ingress; a direct app response cannot substitute for the ingress marker. */
export async function waitForPreviewReadiness(base: string, ingress: PreviewRuntimeInput['ingress'], app: Docker.Container, signal: AbortSignal): Promise<void> {
  const origin = new URL(ingress.previewOrigin)
  try {
    while (true) {
      checkAbort(signal)
      if (!(await app.inspect()).State.Running) throw new PreviewRuntimeError('runtime exited')
      let path = '/'
      let healthy = false
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        checkAbort(signal)
        const requestAbort = new AbortController()
        try {
          const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.any([signal, requestAbort.signal, AbortSignal.timeout(1000)]),
            headers: { host: origin.host, 'x-wrenly-preview-ingress': ingress.capability } })
          if (response.headers.get('x-wrenly-preview-upstream') !== '1') break
          if ((response.status >= 200 && response.status < 300) || [401, 403].includes(response.status)) { healthy = true; break }
          const location = response.headers.get('location')
          if (response.status >= 300 && response.status < 400 && location) {
            const next = new URL(location, origin.origin + path)
            if (next.origin !== origin.origin || hop === MAX_REDIRECTS) throw new PreviewRuntimeError('readiness redirect')
            path = next.pathname + next.search
          } else break
        } catch (error) { if (error instanceof PreviewRuntimeError) throw error; break }
        finally { requestAbort.abort() }
      }
      if (healthy) return
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
  } catch (error) { if (error instanceof PreviewRuntimeError) throw error; throw new PreviewRuntimeError('readiness') }
}

/** Internal adapter only: success retains a live runtime which the caller must explicitly manage/clean. */
export async function startPreviewRuntime(input: PreviewRuntimeInput): Promise<PreviewRuntimeResult> {
  const parent = directory(input.identity)
  const laravel = input.stack === 'laravel'
  if (input.stack && !['nextjs', 'laravel'].includes(input.stack)) throw new PreviewRuntimeError('unsupported stack')
  const environment = laravel ? laravelValidationEnvironment() : ENVIRONMENT
  validateFilePaths(input.files)
  try { if (laravel) validateLaravelSource(input.files); else validateNextjsStyling(input.files) } catch (error) {
    if (error instanceof NextjsStylingError) {
      input.onOutput?.(`Preview source validation: ${error.message}\n`)
      throw new PreviewRuntimeError('styling validation', error.message)
    }
    const detail = error instanceof Error ? error.message : 'Unsupported source.'
    input.onOutput?.(`Preview source validation: ${detail}\n`)
    throw new PreviewRuntimeError('source validation', detail)
  }
  if (!input.files.length || input.files.length > 1000 || Buffer.byteLength(JSON.stringify(input.files)) > MAX_SOURCE_BYTES || !input.files.some(file => file.path === (laravel ? 'composer.json' : 'package.json')))
    throw new PreviewRuntimeError('source validation')
  if (!input.ingressBundle.length || input.ingressBundle.length > MAX_SOURCE_BYTES) throw new PreviewRuntimeError('trusted ingress bundle validation')
  const preparationMs = input.preparationTimeoutMs ?? MAX_PREPARATION_MS
  const readinessMs = input.readinessTimeoutMs ?? MAX_READINESS_MS
  if (![preparationMs, readinessMs].every(value => Number.isSafeInteger(value) && value > 0) || preparationMs > MAX_PREPARATION_MS || readinessMs > MAX_READINESS_MS)
    throw new PreviewRuntimeError('deadline configuration')
  let appContainer: Docker.Container | undefined
  let phase = 'setup'
  let retained = false
  let acquired = false
  let output = ''
  const append = (chunk: string): void => { input.onOutput?.(chunk); output = (output + chunk).slice(-MAX_LOG_CHARS) }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()
  let timer = setTimeout(abort, preparationMs)
  try {
    checkAbort(controller.signal)
    assertPreviewDockerSupport((await docker.version()).Version)
    const image = await docker.getImage(laravel ? LARAVEL_RUNTIME_IMAGE : IMAGE).inspect()
    const imageId = image.Id
    await input.beforeEffect?.(); checkAbort(controller.signal)
    await secureBase(true)
    await mkdir(parent, { recursive: false, mode: 0o700 })
    acquired = true
    const source = await mkdtemp(join(parent, 'source-'))
    await chmod(source, 0o755)
    for (const file of input.files) {
      const target = join(source, file.path)
      await mkdir(join(target, '..'), { recursive: true, mode: 0o755 })
      await writeFile(target, file.content, { flag: 'wx', mode: 0o644 })
    }
    const volume = volumeName(input.identity)
    await input.beforeEffect?.(); checkAbort(controller.signal)
    await docker.createVolume({ Name: volume, Labels: previewResourceLabels(input.identity, 'workspace') })
    if (!owned((await docker.getVolume(volume).inspect()).Labels, input.identity)) throw new PreviewRuntimeError('workspace ownership')
    phase = 'source preparation'
    await runPreparation(['sh', '-c', 'cp -R /source/. /app/ && chmod -R a+rwX /app'], input.identity, imageId,
      [`${source}:/source:ro`, `${volume}:/app`], 'none', controller.signal, append, true, input.beforeEffect, environment)
    phase = 'dependency installation'; append('Installing preview dependencies (lifecycle scripts disabled)...\n')
    await runPreparation(laravel ? LARAVEL_INSTALL_COMMAND : ['bun', 'install', '--ignore-scripts', '--cache-dir', '/app/.wrenly-cache/bun'], input.identity, imageId, [`${volume}:/app`], 'bridge', controller.signal, append, false, input.beforeEffect, environment)
    phase = 'build validation'; append('Revalidating preview source with network disabled...\n')
    await runPreparation(laravel ? LARAVEL_BUILD_COMMAND : ['bun', 'run', 'build'], input.identity, imageId, [`${volume}:/app`], 'none', controller.signal, append, false, input.beforeEffect, environment)
    phase = 'preparation identity'
    let lockOutput = ''
    const hashScript = `import {lstat} from 'fs/promises'; let hash=null; for(const name of ${JSON.stringify(laravel ? ['composer.lock'] : ['bun.lock','bun.lockb'])}) { try {const info=await lstat('/app/'+name); if(!info.isFile()||info.size>${MAX_SOURCE_BYTES}) throw new Error('Invalid lockfile'); hash=new Bun.CryptoHasher('sha256').update(await Bun.file('/app/'+name).arrayBuffer()).digest('hex'); break;} catch(error) {if(error.code!=='ENOENT') throw error;} } console.log(JSON.stringify({hash}));`
    await runPreparation(['bun', '-e', hashScript], input.identity, imageId, [`${volume}:/app:ro`], 'none', controller.signal,
      chunk => { lockOutput = (lockOutput + chunk).slice(-1024) }, false, input.beforeEffect, environment)
    const metadata: unknown = JSON.parse(lockOutput.trim())
    if (typeof metadata !== 'object' || metadata === null || !('hash' in metadata) ||
      !(metadata.hash === null || (typeof metadata.hash === 'string' && /^[0-9a-f]{64}$/.test(metadata.hash)))) throw new PreviewRuntimeError(phase)
    clearTimeout(timer); timer = setTimeout(abort, readinessMs)
    phase = 'runtime start'; checkAbort(controller.signal)
    await input.beforeEffect?.(); checkAbort(controller.signal)
    const appNetwork = await docker.createNetwork({ ...previewNetworkOptions(input.identity.previewId), Labels: previewResourceLabels(input.identity, 'network') })
    await input.beforeEffect?.(); checkAbort(controller.signal)
    const ingressNetwork = await docker.createNetwork({ Name: `wrenly-preview-ingress-${input.identity.previewId}`, Driver: 'bridge', EnableIPv6: false,
      Labels: previewResourceLabels(input.identity, 'network') })
    await input.beforeEffect?.(); checkAbort(controller.signal)
    const app = await docker.createContainer({ Image: imageId, Cmd: laravel ? LARAVEL_START_COMMAND : ['bun', 'run', 'start', '--hostname', '0.0.0.0', '--port', '3000'],
      WorkingDir: '/app', User: '65534:65534', Env: environment, Labels: previewResourceLabels(input.identity, 'app'),
      HostConfig: { ...APP_LIMITS, Binds: [`${volume}:/app`], NetworkMode: appNetwork.id } })
    appContainer = app
    await input.beforeEffect?.(); checkAbort(controller.signal)
    await app.start(); checkAbort(controller.signal)
    const target = resolvePreviewAppTarget(input.identity, await app.inspect(), await appNetwork.inspect())
    const bundlePath = join(parent, 'ingress.js')
    await writeFile(bundlePath, input.ingressBundle, { mode: 0o644, flag: 'wx' })
    const proxyScript = `import {createPreviewIngressHandler} from '/ingress.js'; Bun.serve({hostname:'0.0.0.0',port:8080,fetch:createPreviewIngressHandler(${JSON.stringify({ ...input.ingress, upstream: target })})});`
    await input.beforeEffect?.(); checkAbort(controller.signal)
    const ingress = await docker.createContainer({ Image: imageId, Cmd: ['bun', '-e', proxyScript], User: '65534:65534',
      Labels: previewResourceLabels(input.identity, 'ingress'), Env: ['HOME=/tmp'], ExposedPorts: { [INGRESS_PORT]: {} },
      HostConfig: { ...APP_LIMITS, Memory: 128 * 1024 ** 2, NanoCpus: 1_000_000_000, Binds: [`${bundlePath}:/ingress.js:ro`],
        NetworkMode: ingressNetwork.id, Sysctls: { ...APP_LIMITS.Sysctls, 'net.ipv4.ip_forward': '0' },
        PortBindings: { [INGRESS_PORT]: [{ HostIp: '127.0.0.1', HostPort: '0' }] } } })
    await input.beforeEffect?.(); checkAbort(controller.signal)
    await appNetwork.connect({ Container: ingress.id })
    await input.beforeEffect?.(); checkAbort(controller.signal)
    await ingress.start(); checkAbort(controller.signal)
    const binding = (await ingress.inspect()).NetworkSettings.Ports[INGRESS_PORT]?.[0]
    if (binding?.HostIp !== '127.0.0.1' || !binding.HostPort || !/^\d+$/.test(binding.HostPort)) throw new PreviewRuntimeError('loopback binding')
    const ingressUrl = `http://127.0.0.1:${binding.HostPort}`
    const resources = { appContainerId: app.id, ingressContainerId: ingress.id, appNetworkId: appNetwork.id, ingressNetworkId: ingressNetwork.id }
    await input.onStarted?.(resources, { imageId, lockfileSha256: metadata.hash })
    checkAbort(controller.signal)
    phase = 'readiness'; append('Waiting for isolated preview HTTP readiness...\n')
    await waitForPreviewReadiness(ingressUrl, input.ingress, app, controller.signal)
    checkAbort(controller.signal)
    retained = true
    return { resources,
      ingressUrl, imageId, lockfileSha256: metadata.hash, output }
  } catch (error) {
    if (error instanceof PreviewCleanupError) throw error
    if (appContainer) {
      try {
        const frames = await appContainer.logs({ stdout: true, stderr: true, tail: 100 }) as Buffer
        let offset = 0
        const parts: Buffer[] = []
        while (offset + 8 <= frames.length) {
          const length = frames.readUInt32BE(offset + 4)
          if (offset + 8 + length > frames.length) break
          parts.push(frames.subarray(offset + 8, offset + 8 + length)); offset += 8 + length
        }
        append(Buffer.concat(parts).toString('utf8').slice(-MAX_LOG_CHARS))
      } catch { /* Preserve the original phase failure; cleanup must still run. */ }
    }
    throw new PreviewRuntimeError(controller.signal.aborted ? `${phase} aborted or deadline` : phase, output)
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener('abort', abort)
    if (acquired && !retained) await cleanupPreviewRuntime(input.identity)
  }
}

/** Checks retained runtime/container ownership; this is liveness, not a full HTTP readiness replay. */
export async function assertPreviewRuntimeRunning(identity: PreviewResourceIdentity, runtime: PreviewRuntimeResult): Promise<void> {
  try {
    resolvePreviewAppTarget(identity, await docker.getContainer(runtime.resources.appContainerId).inspect(),
      await docker.getNetwork(runtime.resources.appNetworkId).inspect())
    const ingress = await docker.getContainer(runtime.resources.ingressContainerId).inspect()
    if (!owned(ingress.Config.Labels, identity) || ingress.Config.Labels['io.wrenly.preview-role'] !== 'ingress' ||
      !ingress.State.Running || ingress.State.Paused || ingress.State.Restarting || ingress.State.Dead)
      throw new PreviewRuntimeError('retained runtime liveness')
  } catch { throw new PreviewRuntimeError('retained runtime liveness') }
}

/** Bounded timestamped log snapshot; works for exited containers while preserving claim ownership. */
export async function readPreviewRuntimeLogs(identity: PreviewResourceIdentity, appContainerId: string): Promise<string> {
  const container = docker.getContainer(appContainerId)
  const info = await container.inspect()
  if (!owned(info.Config.Labels, identity) || info.Config.Labels['io.wrenly.preview-role'] !== 'app')
    throw new PreviewRuntimeError('runtime log ownership')
  const frames = await container.logs({ stdout: true, stderr: true, timestamps: true, tail: 100 }) as Buffer
  let offset = 0
  const parts: Buffer[] = []
  while (offset + 8 <= frames.length) {
    const length = frames.readUInt32BE(offset + 4)
    if (offset + 8 + length > frames.length) break
    parts.push(frames.subarray(offset + 8, offset + 8 + length)); offset += 8 + length
  }
  const text = Buffer.concat(parts).toString('utf8')
  return text.length > MAX_LOG_CHARS ? '[Runtime log snapshot truncated]\n' + text.slice(-MAX_LOG_CHARS) : text
}
