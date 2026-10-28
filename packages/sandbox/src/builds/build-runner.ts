// Runs one build attempt in separate dependency-install and offline-validation containers.
// One deadline covers both phases. Exact build/claim labels fence cleanup so a failed
// attempt cannot remove another worker's resources or keep executing after cancellation.
import Docker from 'dockerode'
import { LARAVEL_RUNTIME_IMAGE, LARAVEL_INSTALL_COMMAND, LARAVEL_BUILD_COMMAND, laravelValidationEnvironment, validateLaravelSource } from '../source-policy/laravel-runtime'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Writable, type Duplex } from 'stream'
import { StringDecoder } from 'string_decoder'
import { validateFilePaths } from '../source-policy/file-paths'
import { validateNextjsStyling } from '../source-policy/nextjs-styling'
import { readAppDatabaseManifest } from '../databases/database-manifest'

export type FileTree = Array<{ path: string; content: string }>
export interface SandboxInput {
  files: FileTree
  projectId: string
  stack?: string
  buildId?: string
  claimToken?: string
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  onStage?: (operation: "installation" | "validation", state: "started" | "completed" | "failed") => Promise<void>
  timeoutMs?: number
}
// Persistence failure is a lost execution fence, not an error generated source can repair.
export class SandboxProgressError extends Error {}
export interface SandboxOutput { success: boolean; output: string; error?: string }

type StackSandboxConfig = {
  image: string
  installCmd: string[]
  buildCmd: string[]
}

const STACK_SANDBOX_CONFIG: Record<string, StackSandboxConfig> = {
  nextjs: {
    image: 'oven/bun:alpine',
    installCmd: ['bun', 'install', '--ignore-scripts'],
    buildCmd: ['bun', 'run', 'build'],
  },
  laravel: {
    image: LARAVEL_RUNTIME_IMAGE,
    installCmd: LARAVEL_INSTALL_COMMAND,
    buildCmd: LARAVEL_BUILD_COMMAND,
  },
  vue: {
    // Same as Next.js — Vue also uses bun + vite
    image: 'oven/bun:alpine',
    installCmd: ['bun', 'install', '--ignore-scripts'],
    buildCmd: ['bun', 'run', 'build'],
  },
  django: {
    image: 'python:3.11-alpine',
    installCmd: ['pip', 'install', '-r', 'requirements.txt', '--no-cache-dir'],
    buildCmd: ['python', 'manage.py', 'check', '--deploy'],
  },
}


const SANDBOX_TMP_BASE = path.join(os.tmpdir(), 'wrenly-sandbox')
const DOCKER_REQUEST_TIMEOUT_MS = 10_000
const MAX_LOG_CHARS = 256_000
const CONTAINER_POLL_MS = 200
const SANDBOX_PID_LIMIT = 256
const MAX_FILES = 1000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const LOG_TRUNCATION_MARKER = '[Earlier sandbox output truncated]\n'
const BUILD_LABEL = 'io.wrenly.build-id'
const CLAIM_LABEL = 'io.wrenly.claim-token'
const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: DOCKER_REQUEST_TIMEOUT_MS })
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Signals uncertain cleanup so the worker retains execution ownership for recovery. */
export class SandboxCleanupError extends Error {
  constructor() { super('Sandbox resources could not be cleaned safely. Recovery is required.'); this.name = 'SandboxCleanupError' }
}

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode : undefined
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('Sandbox aborted.')
}

function claimDirectory(buildId: string, claimToken: string): string {
  if (!UUID_PATTERN.test(buildId) || !UUID_PATTERN.test(claimToken)) throw new Error('Invalid sandbox execution identity.')
  return path.join(SANDBOX_TMP_BASE, `${buildId}-${claimToken}`)
}

function memoryLimitBytes(): number {
  const value = process.env.WRENLY_SANDBOX_MEMORY_LIMIT ?? '2048m'
  const match = /^(\d+)([kmg])?$/i.exec(value)
  const multipliers: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
  const bytes = Number(match?.[1]) * (multipliers[match?.[2]?.toLowerCase() ?? ''] ?? 1)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid WRENLY_SANDBOX_MEMORY_LIMIT.')
  return bytes
}

async function removeContainer(container: Docker.Container): Promise<void> {
  try {
    // force removal kills a running container and removes its writable layer.
    await container.remove({ force: true, v: true })
  } catch (error) {
    if (statusCode(error) !== 404) throw new SandboxCleanupError()
  }
}

/** Cleans only resources belonging to this exact claim; safe to retry after partial cleanup. */
export async function cleanupSandboxClaim(buildId: string, claimToken: string): Promise<void> {
  const directory = claimDirectory(buildId, claimToken)
  try {
    const containers = await docker.listContainers({ all: true, filters: JSON.stringify({
      label: [`${BUILD_LABEL}=${buildId}`, `${CLAIM_LABEL}=${claimToken}`],
    }) })
    for (const container of containers) await removeContainer(docker.getContainer(container.Id))
    // Never delete mounts until Docker has acknowledged removal of owned containers.
    fs.rmSync(directory, { recursive: true, force: true })
  } catch { throw new SandboxCleanupError() }
}

async function ensureImage(image: string, signal: AbortSignal): Promise<void> {
  try {
    abortIfRequested(signal)
    try { await docker.getImage(image).inspect(); return }
    catch (error) { if (statusCode(error) !== 404) throw error }
    abortIfRequested(signal)
    if (image === LARAVEL_RUNTIME_IMAGE) throw new Error('Build the trusted local Laravel toolchain first.')
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (error: Error | null, stream: NodeJS.ReadableStream) => {
        if (error) { reject(error); return }
        const onAbort = (): void => {
          if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy()
          reject(signal.reason ?? new Error('Image acquisition aborted.'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) { onAbort(); signal.removeEventListener('abort', onAbort); return }
        docker.modem.followProgress(stream, (failure: Error | null) => {
          signal.removeEventListener('abort', onAbort)
          if (failure) reject(failure); else resolve()
        })
      })
    })
  } catch (error) { throw new Error(image === LARAVEL_RUNTIME_IMAGE ? 'Laravel runtime image is unavailable. Build it with docker build -t wrenly/laravel-runtime:13-php8.4 packages/sandbox/images/laravel.' : 'Sandbox image acquisition failed.', { cause: error }) }
}

async function runContainer(
  command: string[], image: string, workDir: string, buildId: string, claimToken: string,
  network: 'bridge' | 'none', signal: AbortSignal, append: (chunk: string) => void,
  environment?: string[],
): Promise<number> {
  let container: Docker.Container | undefined
  let attached: Duplex | undefined
  const stdout = new StringDecoder('utf8')
  const stderr = new StringDecoder('utf8')
  const output = (decoder: StringDecoder): Writable => new Writable({
    write(chunk: Buffer, _encoding, callback) { append(decoder.write(chunk)); callback() },
  })
  const cpu = Number(process.env.WRENLY_SANDBOX_CPU_LIMIT ?? '2')
  if (!Number.isFinite(cpu) || cpu <= 0) throw new Error('Invalid WRENLY_SANDBOX_CPU_LIMIT.')
  try {
    abortIfRequested(signal)
    container = await docker.createContainer({
      Image: image, Cmd: command, WorkingDir: '/app',
      Env: environment,
      User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      Labels: { [BUILD_LABEL]: buildId, [CLAIM_LABEL]: claimToken },
      HostConfig: { Binds: [`${workDir}:/app`], Memory: memoryLimitBytes(),
        NanoCpus: cpu * 1_000_000_000, NetworkMode: network, CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'], PidsLimit: SANDBOX_PID_LIMIT },
      AttachStdout: true, AttachStderr: true,
    })
    abortIfRequested(signal)
    attached = await container.attach({ stream: true, stdout: true, stderr: true }) as Duplex
    // The execution deadline owns stream lifetime; daemon request idleness must not kill quiet builds.
    if ('setTimeout' in attached && typeof attached.setTimeout === 'function') attached.setTimeout(0)
    let streamError: unknown
    const streamDone = new Promise<void>((resolve) => {
      attached!.once('end', resolve)
      attached!.once('error', (error: unknown) => { streamError = error; resolve() })
    })
    container.modem.demuxStream(attached, output(stdout), output(stderr))
    abortIfRequested(signal)
    await container.start()
    let removeAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new Error('Sandbox aborted.'))
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
    })
    void aborted.catch(() => {})
    try {
      let exitCode = 0
      while (true) {
        abortIfRequested(signal)
        const state = await container.inspect()
        if (!state.State.Running) { exitCode = state.State.ExitCode; break }
        await Promise.race([new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS)), aborted])
      }
      await Promise.race([streamDone, aborted])
      if (streamError) throw streamError
      return exitCode
    } finally { removeAbort() }
  } catch (error) {
    throw new Error('Sandbox container execution failed.', { cause: error })
  } finally {
    try { if (container) await removeContainer(container) }
    finally { attached?.destroy(); append(stdout.end()); append(stderr.end()) }
  }
}

/** Runs install and offline validation within one deadline, retaining partial diagnostics. */
export async function runSandbox(input: SandboxInput): Promise<SandboxOutput> {
  let output = ''
  const append = (chunk: string): void => {
    input.onOutput?.(chunk)
    output += chunk
    if (output.length > MAX_LOG_CHARS)
      output = LOG_TRUNCATION_MARKER + output.slice(-(MAX_LOG_CHARS - LOG_TRUNCATION_MARKER.length))
  }
  let identity: { buildId: string; claimToken: string } | undefined
  let workspace: string | undefined
  let parent: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(input.signal?.reason ?? new Error('Sandbox aborted.'))
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (input.signal?.aborted) onAbort()
    abortIfRequested(controller.signal)
    validateFilePaths(input.files)
    if (!input.files.length || input.files.length > MAX_FILES || Buffer.byteLength(JSON.stringify(input.files)) > MAX_SOURCE_BYTES)
      throw new Error('Generated source exceeds sandbox file limits.')
    const stack = input.stack ?? 'nextjs'
    // A compiler passing without a database proves neither migrations nor application
    // access. Declared database apps use the separately selected disposable validator;
    // this stateless runner must never skip those checks or connect existing data.
    if (readAppDatabaseManifest(input.files, stack))
      throw new Error('Select a ready Development database before building this revision. Database-backed builds must be enabled on this instance; no existing data was accessed.')
    if (stack === 'nextjs') validateNextjsStyling(input.files)
    if (stack === 'laravel') validateLaravelSource(input.files)
    const config = STACK_SANDBOX_CONFIG[stack]
    if (!config) throw new Error('Unsupported sandbox stack.')
    const required = stack === 'laravel' ? 'composer.json' : stack === 'django' ? 'requirements.txt' : 'package.json'
    const manifest = input.files.find((file) => file.path === required)
    if (!manifest) throw new Error(`Generated source is missing ${required}.`)
    if (required.endsWith('.json')) JSON.parse(manifest.content)
    const timeoutMs = input.timeoutMs ?? Number(process.env.WRENLY_SANDBOX_TIMEOUT_SECONDS ?? '300') * 1000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid sandbox execution deadline.')
    timer = setTimeout(() => controller.abort(new Error('Sandbox execution deadline exceeded.')), timeoutMs)
    const buildId = input.buildId ?? crypto.randomUUID()
    const claimToken = input.claimToken ?? crypto.randomUUID()
    parent = claimDirectory(buildId, claimToken)
    identity = { buildId, claimToken }
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    workspace = fs.mkdtempSync(path.join(parent, 'attempt-'))
    for (const file of input.files) {
      const target = path.join(workspace, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, { encoding: 'utf8', flag: 'wx' })
    }
    await ensureImage(config.image, controller.signal)
    const imageId = (await docker.getImage(config.image).inspect()).Id
    const environment = stack === 'laravel' ? laravelValidationEnvironment() : undefined
    const stage = async (operation: "installation" | "validation", state: "started" | "completed" | "failed"): Promise<void> => {
      try { await input.onStage?.(operation, state); abortIfRequested(controller.signal) }
      catch (error) { throw new SandboxProgressError('Sandbox activity could not be persisted.', {cause: error}) }
    }
    await stage('installation', 'started')
    append('Installing dependencies...\n')
    const installed = await runContainer(config.installCmd, imageId, workspace, buildId, claimToken, 'bridge', controller.signal, append, environment)
    await stage('installation', installed === 0 ? 'completed' : 'failed')
    if (installed !== 0) return { success: false, output, error: `Dependency installation failed (exit ${installed}).` }
    await stage('validation', 'started')
    append('\nBuilding with network disabled...\n')
    const built = await runContainer(config.buildCmd, imageId, workspace, buildId, claimToken, 'none', controller.signal, append, environment)
    await stage('validation', built === 0 ? 'completed' : 'failed')
    return built === 0 ? { success: true, output } : { success: false, output, error: `Build failed (exit ${built}).` }
  } catch (error) {
    if (error instanceof SandboxCleanupError || error instanceof SandboxProgressError) throw error
    return { success: false, output, error: controller.signal.aborted ? 'Sandbox execution was aborted or exceeded its deadline.' : error instanceof Error ? error.message : 'Sandbox execution failed.' }
  } finally {
    if (timer) clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
    // Claim-wide cleanup also catches a create request with an uncertain response.
    if (parent && identity) await cleanupSandboxClaim(identity.buildId, identity.claimToken)
  }
}
