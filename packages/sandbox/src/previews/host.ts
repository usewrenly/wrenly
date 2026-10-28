// Probes Docker isolation with trusted fixture code before allowing local previews.
// Unsupported daemons or reachable host endpoints fail closed, without generated application code.
import Docker from 'dockerode'
import { networkInterfaces, hostname } from 'os'
import { previewNetworkOptions, assertPreviewDockerSupport } from './network'

/** Controlled startup probe: generated code is never used to establish the host boundary. */
export async function verifyPreviewHost(): Promise<void> {
  const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 10_000 })
  const id = crypto.randomUUID()
  let network: Docker.Network | undefined
  let container: Docker.Container | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const listener = Bun.serve({ hostname: '::', port: 0, fetch: () => new Response('Preview isolation probe') })
  try {
    assertPreviewDockerSupport((await docker.version()).Version)
    if ((await docker.info()).Name !== hostname()) throw new Error('Preview API must run on the local Docker Engine host; remote daemons and Docker Desktop are unsupported.')
    const image = (await docker.getImage('oven/bun:alpine').inspect()).Id
    network = await docker.createNetwork(previewNetworkOptions(id))
    const info = await network.inspect()
    if (info.EnableIPv6 || info.IPAM?.Config?.some(entry => entry.Gateway)) throw new Error('Preview network isolation is unavailable.')
    const subnet = info.IPAM?.Config?.[0]?.Subnet?.split('/')[0]?.split('.')
    if (!subnet || subnet.length !== 4) throw new Error('Preview probe requires a private IPv4 subnet.')
    subnet[3] = '1'
    const targets = [...new Set([subnet.join('.'), ...Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
      .filter(entry => !entry.internal).map(entry => entry.address.startsWith('fe80:') ? entry.address + '%eth0' : entry.address))])]
    const script = `const routes=await Bun.file('/proc/net/route').text();const defaultRoute=routes.split('\\n').slice(1).some(line=>line.trim().split(/\\s+/)[1]==='00000000');
      const ipv6=await Bun.file('/proc/net/if_inet6').text().catch(()=> '');const externalV6=ipv6.trim().split('\\n').some(line=>line&& !line.trim().endsWith('lo'));
      const targets=${JSON.stringify(targets)};const reachable=await Promise.all(targets.map(hostname=>new Promise(resolve=>{let finished=false;let socket;const done=value=>{if(finished)return;finished=true;clearTimeout(timer);socket?.end();resolve(value)};const timer=setTimeout(()=>done(false),500);Bun.connect({hostname,port:${listener.port},socket:{open(s){socket=s;done(true);s.end()},data(){},error(){done(false)},close(){done(false)}}}).then(s=>{socket=s;if(finished)s.end()}).catch(()=>done(false))})));
      process.exit(defaultRoute||externalV6||reachable.some(Boolean)?1:0);`
    container = await docker.createContainer({ Image: image, Cmd: ['bun', '-e', script], User: '65534:65534', Labels: { 'io.wrenly.preview-probe': id },
      HostConfig: { NetworkMode: network.id, Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1' }, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true,
        Memory: 128 * 1024 ** 2, NanoCpus: 1_000_000_000, PidsLimit: 64 } })
    await container.start()
    const result = await Promise.race([container.wait(), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Preview host probe timed out.')), 5000) })])
    if (result.StatusCode !== 0) throw new Error('Preview host isolation probe failed; local previews will not start.')
  } finally {
    if (deadline) clearTimeout(deadline)
    try { if (container) await container.remove({ force: true, v: true }) }
    finally { try { if (network) await network.remove() } finally { await listener.stop(true) } }
  }
}
