// COMPONENT: Preview network policy
// PURPOSE: Define isolated, per-preview app networking without fallback to default bridge.
// INPUTS: Preview UUID.
// OUTPUTS: Docker network creation options; no resources created on import.
// STEPS: Validate identity, use internal isolated IPv4 bridge, disable IPv6.
// EDGE CASES: Unsupported gateway mode must fail closed during creation/probes.
// ERROR STATES: Invalid IDs reject; Docker capability failures must not trigger fallback.
import type Docker from 'dockerode'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Produces the app network policy; ingress reachability and host isolation require runtime probes. */
export function previewNetworkOptions(previewId: string): Docker.NetworkCreateOptions {
  if (!UUID_PATTERN.test(previewId)) throw new Error('Invalid preview identity.')
  return {
    Name: `wrenly-preview-${previewId}`, Driver: 'bridge', Internal: true, EnableIPv6: false,
    Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    Labels: { 'io.wrenly.preview-id': previewId },
  }
}

/** Requires modern loopback-publishing protection; unsupported/unknown daemons fail closed. */
export function assertPreviewDockerSupport(version: string): void {
  const major = /^([0-9]+)\./.exec(version)?.[1]
  if (!major || Number(major) < 28)
    throw new Error('Local previews require Docker Engine 28 or newer and passing isolation probes.')
}
