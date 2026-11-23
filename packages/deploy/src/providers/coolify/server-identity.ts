/** Read-only Coolify server identity. Unrelated provider fields and credentials never leave this adapter. */
import type { DeploymentProviderClient } from "../../http/provider-client";
export interface CoolifyServerIdentity {
  uuid: string;
  address: string;
  port: number;
}
/** Reads the explicitly selected server; redirects and response bounds belong to the provider client. */
export async function readCoolifyServerIdentity(
  client: DeploymentProviderClient,
  serverId: string,
  signal: AbortSignal,
): Promise<CoolifyServerIdentity> {
  try {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serverId))
      throw new Error("Invalid server identifier.");
    const raw = await client.request(
      "GET",
      `/api/v1/servers/${serverId}`,
      undefined,
      signal,
    );
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid server identity.");
    const value = raw as Record<string, unknown>;
    if (
      value.uuid !== serverId ||
      typeof value.ip !== "string" ||
      !value.ip.length ||
      value.ip.length > 253 ||
      /[\s/\\@]/.test(value.ip) ||
      typeof value.port !== "number" ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535
    )
      throw new Error("Invalid server identity.");
    signal.throwIfAborted();
    return { uuid: serverId, address: value.ip, port: value.port };
  } catch {
    throw new Error("The selected Coolify server could not be verified.");
  }
}
