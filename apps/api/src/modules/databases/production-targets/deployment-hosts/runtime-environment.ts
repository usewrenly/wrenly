/** Verify provider metadata separately from the immutable image environment. */
import { isIP } from "node:net";
const MAX_METADATA_LENGTH = 100;
const SERVICE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
function entries(values: string[] | null): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const entry of values ?? []) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || result.has(name)) return null;
    result.set(name, entry.slice(separator + 1));
  }
  return result;
}
/**
 * COMPONENT: Runtime environment verification
 * PURPOSE: Permit fixed Coolify service metadata without accepting executable settings.
 * INPUTS: Image/container environments, ownership labels and selected deployment.
 * OUTPUTS: Whether image values and the complete optional provider metadata match.
 * STEPS: Reject malformed/duplicate keys; compare image values; verify metadata identity.
 * EDGE CASES: Native runtimes need no metadata; partial provider metadata is refused.
 * ERROR STATES: Unknown keys, overrides or changed service identity return false.
 */
export function matchesRuntimeEnvironment(
  actual: string[] | null,
  image: string[] | null,
  labels: Record<string, string>,
  deploymentId: string,
  service: "application" | "ingress",
): boolean {
  const expected = entries(image), received = entries(actual);
  if (!expected || !received) return false;
  for (const [name, value] of expected) {
    if (received.get(name) !== value) return false;
    received.delete(name);
  }
  if (received.size === 0) return true;
  const serviceId = labels["coolify.serviceUuid"] ?? "";
  if (!SERVICE_ID.test(serviceId)) return false;
  const fixed: Record<string, string> = {
    COOLIFY_RESOURCE_UUID: serviceId,
    COOLIFY_CONTAINER_NAME: `${service}-${serviceId}`,
    COOLIFY_APP_NAME: `wrenly-${deploymentId}`,
    SERVICE_NAME_APPLICATION: "application",
    SERVICE_NAME_INGRESS: "ingress",
  };
  for (const [name, value] of Object.entries(fixed)) {
    if (received.get(name) !== value) return false;
    received.delete(name);
  }
  for (const name of ["COOLIFY_PROJECT_NAME", "COOLIFY_ENVIRONMENT_NAME"]) {
    const value = received.get(name);
    if (!value || value.length > MAX_METADATA_LENGTH || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
    received.delete(name);
  }
  const address = received.get("COOLIFY_SERVER_IP");
  if (!address || !isIP(address)) return false;
  received.delete("COOLIFY_SERVER_IP");
  // No prefix wildcard: NODE_OPTIONS, database URLs and all unknown additions fail.
  return received.size === 0;
}
