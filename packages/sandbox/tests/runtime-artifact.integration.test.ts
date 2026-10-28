// Trusted Next.js fixture executes only in the bounded artifact/runtime containers.
import { describe, expect, test } from 'bun:test'
import Docker from 'dockerode'
import { ARTIFACT_WATCHDOG_SOURCE } from '../src/artifacts/artifact-watchdog'
import { buildRuntimeArtifact, cleanupRuntimeArtifactPreparation } from '../src/artifacts/runtime-artifact'
const integration = process.env.WRENLY_TEST_DOCKER === 'true' ? describe : describe.skip
integration('sandbox runtime artifact', () => {
  test('watchdog child cannot signal its privileged guardian', async () => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const script = ARTIFACT_WATCHDOG_SOURCE.replace("cwd:'/app'", "cwd:'/'").replace('process.argv[2]', 'process.argv[1]').replace('slice(3)', 'slice(2)')
    const child = "if(process.getuid()!==1000)process.exit(1);try{process.kill(1,0);process.exit(2)}catch(error){if(error.code!=='EPERM')process.exit(3)}try{process.setuid(0);process.exit(4)}catch(error){process.exit(error.code==='EPERM'?0:5)}"
    const container = await docker.createContainer({ Image: 'oven/bun:alpine', WorkingDir: '/', User: '0:0',
      Cmd: ['bun', '--eval', script, '5000', 'bun', '--eval', child], HostConfig: { NetworkMode: 'none',
        CapDrop: ['ALL'], CapAdd: ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges:true'], Memory: 128 * 1024 ** 2, NanoCpus: 1_000_000_000 } })
    try { await container.start(); expect((await container.wait()).StatusCode).toBe(0) }
    finally { await container.remove({ force: true, v: true }) }
  }, 15_000)
  test('trusted PID 1 watchdog ends a hung unprivileged command without an API timer', async () => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const container = await docker.createContainer({ Image: 'oven/bun:alpine', WorkingDir: '/', User: '0:0',
      Cmd: ['bun', '--eval', ARTIFACT_WATCHDOG_SOURCE.replace("cwd:'/app'", "cwd:'/'").replace('process.argv[2]', 'process.argv[1]').replace('slice(3)', 'slice(2)'), '500', 'sh', '-c', 'sleep 10'],
      HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], CapAdd: ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges:true'], Memory: 128 * 1024 ** 2, NanoCpus: 1_000_000_000 } })
    try {
      await container.start()
      const result = await container.wait()
      expect(result.StatusCode).toBe(137)
      expect((await container.inspect()).State.Running).toBe(false)
    } finally { await container.remove({ force: true, v: true }) }
  }, 15_000)

  test('retains a runnable image without a source mount or remote rebuild', async () => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' })
    const deploymentId = crypto.randomUUID()
    let imageId: string | undefined; let container: Docker.Container | undefined
    try {
      const artifact = await buildRuntimeArtifact({ deploymentId, signal: new AbortController().signal, beforeEffect: async () => {}, files: [
        { path: 'package.json', content: JSON.stringify({ name: 'artifact-fixture', scripts: { build: 'next build' }, dependencies: {
          next: '15.5.28', react: '19.3.1', 'react-dom': '19.3.1' } }) },
        { path: 'next.config.mjs', content: 'export default { experimental: { cpus: 1 } }' },
        { path: 'app/layout.jsx', content: 'export default function Layout({children}) { return <html><body>{children}</body></html> }' },
        { path: 'app/page.jsx', content: 'export default function Page() { return <main>Artifact fixture</main> }' },
      ] })
      imageId = artifact.imageId
      expect(imageId).toMatch(/^sha256:/)
      const image = await docker.getImage(imageId).inspect()
      expect(image.Config.User).toBe('1000:1000')
      expect(image.Config.Labels?.['io.wrenly.artifact-role']).toBe('runtime')
      expect(image.Config.Labels?.['io.wrenly.deployment-id']).toBe(deploymentId)
      expect(artifact.sizeBytes).toBeLessThanOrEqual(1024 ** 3)
      container = await docker.createContainer({ Image: imageId, HostConfig: { NetworkMode: 'none', Memory: 2 * 1024 ** 3,
        NanoCpus: 2_000_000_000, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] } })
      await container.start()
      await cleanupRuntimeArtifactPreparation(deploymentId)
      expect((await container.inspect()).State.Running).toBe(true)
      const probe = await container.exec({ Cmd: ['bun', '--eval', `for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:3000');const marker=await fetch('http://127.0.0.1:3000/.well-known/wrenly-deployment');if((await r.text()).includes('Artifact fixture')&&(await marker.text())==='${deploymentId}'){console.log('ARTIFACT_HTTP_READY');process.exit(0)}}catch{}await Bun.sleep(250)}process.exit(1)`], AttachStdout: true, AttachStderr: true })
      const stream = await probe.start({})
      let output = ''
      await new Promise<void>((resolve, reject) => { stream.on('data', (chunk: Buffer) => { output += chunk.toString() }); stream.once('end', resolve); stream.once('error', reject) })
      expect(output).toContain('ARTIFACT_HTTP_READY')
      expect((await probe.inspect()).ExitCode).toBe(0)
      await container.remove({ force: true, v: true }); container = undefined
      expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.deployment-id=${deploymentId}`] }) })).toHaveLength(0)
    } finally {
      await container?.remove({ force: true, v: true })
      if (imageId) await docker.getImage(imageId).remove({ force: true })
    }
  }, 300_000)
})
