import { expect, test } from 'bun:test'
import type Docker from 'dockerode'
import { previewResourceLabels, resolvePreviewAppTarget, type PreviewResourceIdentity } from '../src/previews/target'

function fixture(): { identity: PreviewResourceIdentity; container: Docker.ContainerInspectInfo; network: Docker.NetworkInspectInfo } {
  const identity = { previewId: crypto.randomUUID(), projectId: crypto.randomUUID(), buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() }
  const containerId = 'a'.repeat(64)
  const networkId = 'b'.repeat(64)
  // Only fields inspected by the resolver are fixture data; full daemon shape is exercised by the Docker probe.
  const container = { Id: containerId, Config: { Labels: previewResourceLabels(identity, 'app') },
    State: { Running: true, Paused: false, Restarting: false, Dead: false },
    HostConfig: { NetworkMode: networkId, PortBindings: {} },
    NetworkSettings: { Ports: { '3000/tcp': null }, Networks: { isolated: {
      NetworkID: networkId, EndpointID: 'endpoint', IPAddress: '172.30.0.2', Gateway: '', IPv6Gateway: '', GlobalIPv6Address: '',
    } } } } as unknown as Docker.ContainerInspectInfo
  const network = { Id: networkId, Name: `wrenly-preview-${identity.previewId}`, Driver: 'bridge', Internal: true,
    EnableIPv6: false, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    Labels: previewResourceLabels(identity, 'network'), IPAM: { Config: [{ Subnet: '172.30.0.0/24' }] },
    Containers: { [containerId]: { EndpointID: 'endpoint', IPv4Address: '172.30.0.2/24', IPv6Address: '' } },
  } as unknown as Docker.NetworkInspectInfo
  return { identity, container, network }
}

test('derives target only from matching claim-owned isolated endpoints', () => {
  const { identity, container, network } = fixture()
  expect(resolvePreviewAppTarget(identity, container, network)).toBe('http://172.30.0.2:3000')
  expect(() => previewResourceLabels({ ...identity, previewId: '../escape' }, 'app')).toThrow()
})

test('rejects stale claims, foreign builds and replaced networks', () => {
  for (const field of ['claimToken', 'buildId', 'projectId', 'previewId'] as const) {
    const { identity, container, network } = fixture()
    expect(() => resolvePreviewAppTarget({ ...identity, [field]: crypto.randomUUID() }, container, network)).toThrow('ownership')
  }
  const { identity, container, network } = fixture()
  network.Id = 'c'.repeat(64)
  expect(() => resolvePreviewAppTarget(identity, container, network)).toThrow('membership')
})

test('rejects stopped apps, routing gateways, additional networks and published ports', () => {
  const changes: Array<(container: Docker.ContainerInspectInfo, network: Docker.NetworkInspectInfo) => void> = [
    container => { container.State.Running = false },
    container => { container.State.Paused = true },
    (_container, network) => { network.Internal = false },
    (_container, network) => { network.EnableIPv6 = true },
    (_container, network) => { network.Options = {} },
    (_container, network) => { network.IPAM = { Config: [{ Gateway: '172.30.0.1' }] } },
    container => { container.NetworkSettings.Networks.isolated!.Gateway = '172.30.0.1' },
    container => { container.NetworkSettings.Networks.extra = container.NetworkSettings.Networks.isolated! },
    container => { container.NetworkSettings.Ports['3000/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '1234' }] },
    container => { container.HostConfig.PortBindings = { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '1234' }] } },
    (_container, network) => { network.Containers = {} },
    (container, network) => { network.Containers![container.Id]!.IPv4Address = '172.30.0.3/24' },
    container => { container.NetworkSettings.Networks.isolated!.IPAddress = '127.0.0.1' },
  ]
  for (const change of changes) {
    const { identity, container, network } = fixture()
    change(container, network)
    expect(() => resolvePreviewAppTarget(identity, container, network)).toThrow()
  }
})
