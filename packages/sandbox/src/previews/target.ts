// Resolves an app address only from fresh Docker inspections with matching ownership.
// Browser/model URLs cannot choose the destination; isolated membership and unpublished ports are required.
import type Docker from 'dockerode'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOCKER_ID_PATTERN = /^[0-9a-f]{64}$/
const APP_PORT = 3000
const LABEL_PREFIX = 'io.wrenly.'
export interface PreviewResourceIdentity {
  previewId: string
  projectId: string
  buildId: string
  claimToken: string
}

/** Labels bind runtime resources to one operation; they must come from persisted server identity. */
export function previewResourceLabels(identity: PreviewResourceIdentity, role: 'app' | 'network' | 'workspace' | 'prepare' | 'ingress'): Record<string, string> {
  if (![identity.previewId, identity.projectId, identity.buildId, identity.claimToken].every(value => UUID_PATTERN.test(value))) throw new Error('Invalid preview resource identity.')
  return {
    [`${LABEL_PREFIX}preview-id`]: identity.previewId,
    [`${LABEL_PREFIX}project-id`]: identity.projectId,
    [`${LABEL_PREFIX}build-id`]: identity.buildId,
    [`${LABEL_PREFIX}claim-token`]: identity.claimToken,
    [`${LABEL_PREFIX}preview-role`]: role,
  }
}

function assertLabels(actual: Record<string, string> | undefined, expected: Record<string, string>): void {
  if (Object.entries(expected).some(([name, value]) => actual?.[name] !== value))
    throw new Error('Preview Docker ownership does not match.')
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

/** Accept only fresh trusted Docker inspections, never request payloads. This does not replace host isolation probes. */
export function resolvePreviewAppTarget(identity: PreviewResourceIdentity,
  container: Docker.ContainerInspectInfo, network: Docker.NetworkInspectInfo): string {
  assertLabels(container.Config.Labels, previewResourceLabels(identity, 'app'))
  assertLabels(network.Labels, previewResourceLabels(identity, 'network'))
  if (!DOCKER_ID_PATTERN.test(container.Id) || !DOCKER_ID_PATTERN.test(network.Id))
    throw new Error('Invalid preview Docker resource identifiers.')
  if (!container.State.Running || container.State.Paused || container.State.Restarting || container.State.Dead)
    throw new Error('Preview app is not running.')
  if (network.Name !== `wrenly-preview-${identity.previewId}` || network.Driver !== 'bridge' ||
    !network.Internal || network.EnableIPv6 || network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
    !network.IPAM?.Config?.length || network.IPAM.Config.some(subnet => Boolean(subnet.Gateway)))
    throw new Error('Preview app network is not isolated.')
  const endpoints = Object.values(container.NetworkSettings.Networks)
  const endpoint = endpoints[0]
  if (endpoints.length !== 1 || !endpoint || endpoint.NetworkID !== network.Id ||
    container.HostConfig.NetworkMode !== network.Id || endpoint.Gateway || endpoint.IPv6Gateway || endpoint.GlobalIPv6Address ||
    !privateIpv4(endpoint.IPAddress)) throw new Error('Preview app network membership is invalid.')
  const member = network.Containers?.[container.Id]
  if (!member || member.EndpointID !== endpoint.EndpointID || member.IPv4Address.split('/')[0] !== endpoint.IPAddress || member.IPv6Address)
    throw new Error('Preview app address is not verified by its network.')
  if (Object.values(container.NetworkSettings.Ports ?? {}).some(bindings => bindings != null && (!Array.isArray(bindings) || bindings.length > 0)) ||
    Object.values(container.HostConfig.PortBindings ?? {}).some(bindings => bindings != null && (!Array.isArray(bindings) || bindings.length > 0)))
    throw new Error('Preview app ports must not be published.')
  return `http://${endpoint.IPAddress}:${APP_PORT}`
}
