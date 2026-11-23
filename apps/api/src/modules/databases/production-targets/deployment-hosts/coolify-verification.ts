/** Connects the saved SSH destination to the server explicitly selected in the configured Coolify installation. */
import {
  readCoolifyServerIdentity,
  createDeploymentProviderClient,
} from "@wrenly/deploy";
import type {
  ProductionRuntimeHostTarget,
  ProductionRuntimeHostIdentity,
} from "@wrenly/db/production-host-contract";
import {
  resolveRuntimeHostAddresses,
  type RuntimeHostLookup,
} from "./transport";

/** The SSH host key authenticates the machine; Coolify's read independently checks its reviewed placement. */
export function createCoolifyHostVerifier(configuration: {
  origin: string;
  token: string;
  serverId: string;
  lookup?: RuntimeHostLookup;
  transport?: typeof fetch;
}): (
  serverId: string,
  identity: ProductionRuntimeHostIdentity,
  target: ProductionRuntimeHostTarget,
  addresses: string[],
  signal: AbortSignal,
) => Promise<void> {
  const client = createDeploymentProviderClient(
    {
      origin: configuration.origin,
      token: configuration.token,
      authentication: "Bearer",
    },
    configuration.transport,
  );
  return async (
    serverId,
    _identity,
    target,
    addresses,
    signal,
  ): Promise<void> => {
    try {
      if (serverId !== configuration.serverId)
        throw new Error("Deployment server changed.");
      const server = await readCoolifyServerIdentity(client, serverId, signal);
      if (server.port !== target.port)
        throw new Error("Deployment SSH port changed.");
      const current = await resolveRuntimeHostAddresses(
        target.host,
        signal,
        configuration.lookup,
      );
      if (JSON.stringify(current) !== JSON.stringify(addresses))
        throw new Error("Deployment addresses changed.");
      // The SSH transport selects the first pinned address. A provider hostname
      // must exactly match the reviewed hostname; alternate aliases need new review.
      if (server.address !== target.host && server.address !== current[0])
        throw new Error("Deployment destination changed.");
      signal.throwIfAborted();
    } catch {
      throw new Error(
        "The deployment host does not match the selected Coolify server.",
      );
    }
  };
}
