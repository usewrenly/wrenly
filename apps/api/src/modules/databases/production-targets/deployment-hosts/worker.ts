/** Checks one saved registration. Importing this module never starts an SSH connection or worker. */
import type { db } from "@wrenly/db";
import type {
  ProductionRuntimeHostTarget,
  ProductionRuntimeHostIdentity,
} from "@wrenly/db/production-host-contract";
import {
  claimRuntimeHostConnection,
  loadRuntimeHostConnection,
  finishRuntimeHostConnection,
  type RuntimeHostReceipt,
} from "./store";
import {
  resolveRuntimeHostAddresses,
  inspectRemoteRuntimeHost,
  type RuntimeHostLookup,
} from "./transport";
const CHECK_TIMEOUT_MS = 30_000;
/** A deployment adapter must prove the inspected daemon belongs to the reviewed Coolify server before success is saved. */
export async function runRuntimeHostCheckOnce(input: {
  database: typeof db;
  directory: string;
  signal?: AbortSignal;
  lookup?: RuntimeHostLookup;
  verifyDeploymentServer: (
    serverId: string,
    identity: ProductionRuntimeHostIdentity,
    target: ProductionRuntimeHostTarget,
    addresses: string[],
    signal: AbortSignal,
  ) => Promise<void>;
}): Promise<RuntimeHostReceipt | null> {
  input.signal?.throwIfAborted();
  const claim = await claimRuntimeHostConnection(input.database);
  if (!claim) return null;
  const signal = AbortSignal.any([
    AbortSignal.timeout(CHECK_TIMEOUT_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  let outcome: Parameters<typeof finishRuntimeHostConnection>[2];
  try {
    const saved = await loadRuntimeHostConnection(
      input.database,
      claim,
      input.directory,
    );
    const addresses = await resolveRuntimeHostAddresses(
      saved.target.host,
      signal,
      input.lookup,
    );
    const inspection = await inspectRemoteRuntimeHost({
      ...saved,
      addresses,
      signal,
      lookup: input.lookup,
    });
    await input.verifyDeploymentServer(
      saved.serverId,
      inspection,
      saved.target,
      addresses,
      signal,
    );
    signal.throwIfAborted();
    outcome = {
      status: "verified",
      inspection,
      pinned: { target: saved.target, addresses },
    };
  } catch {
    outcome = { status: signal.aborted ? "interrupted" : "refused" };
  }
  try {
    return await finishRuntimeHostConnection(input.database, claim, outcome);
  } catch {
    throw new Error(
      "Deployment host check completion could not be confirmed. Check its saved status before continuing.",
    );
  }
}
