/** One persisted provider creation; importing this file does not start a polling loop. */
import type { db } from "@wrenly/db";
import { resolveDatabaseProvider, type DatabaseProvider } from "@wrenly/deploy";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import { claimProductionProvision, beginProductionProviderEffect, finishProductionProviderEffect, type ProvisionReceipt } from "./store";
/** Holds the resource kernel lock across saved intent, provider request and saved acknowledgement. */
export async function runProductionProvisionOnce(input: {
  database: typeof db;
  directory: string;
  providers: readonly DatabaseProvider[];
  signal: AbortSignal;
}): Promise<ProvisionReceipt | null> {
  input.signal.throwIfAborted();
  const claim = await claimProductionProvision(input.database);
  if (!claim) return null;
  const provider = resolveDatabaseProvider(input.providers, claim.providerId);
  const lock = await acquireDatabaseExecutorLock({ id: claim.id, resourceId: claim.id, projectId: claim.projectId, token: claim.token });
  try {
    lock.assertHeld();
    input.signal.throwIfAborted();
    const saved = await beginProductionProviderEffect(input.database, claim, input.directory);
    lock.assertHeld();
    let remoteUuid: string | null = null;
    try {
      input.signal.throwIfAborted();
      if (saved.placement.providerId !== provider.id) throw new Error("Saved provider changed.");
      remoteUuid = await provider.createStopped({ resourceId: saved.resourceId, operationId: saved.operationId, placement: saved.placement }, saved.credential, input.signal);
    } catch {
      // The provider may have saved its record even when the response was lost.
      // Preserve uncertainty and never issue another POST from this claim.
      remoteUuid = null;
    }
    lock.assertHeld();
    return await finishProductionProviderEffect(input.database, claim, remoteUuid);
  } finally {
    await lock.release();
  }
}
