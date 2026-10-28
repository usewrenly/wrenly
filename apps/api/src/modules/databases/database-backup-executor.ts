// Backup verification restores a separate disposable copy, never over the saved source.
import { join } from "node:path";
import {
  createManagedDatabase,
  cleanupDisposableDatabase,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import {
  captureManagedDatabaseBackup,
  restoreDisposableDatabaseBackup,
} from "@wrenly/sandbox/database-backup-runtime";
import {
  provisionManagedDatabaseRoles,
  inspectManagedDatabaseSchema,
} from "@wrenly/sandbox/database-administrator";
import type { loadDatabaseExecution, DatabaseClaim } from "./database-store";
import { createDatabaseCredentials } from "./database-contract";
import { loadDatabaseKey } from "./database-secrets";
import {
  sealDatabaseBackup,
  openDatabaseBackup,
} from "./database-backup-storage";
/** Returns durable metadata only after proving that the sealed archive restores and its schema/journal matches. */
export async function executeManagedDatabaseBackup(input: {
  claim: DatabaseClaim;
  execution: Awaited<ReturnType<typeof loadDatabaseExecution>>;
  directory: string;
  bundle: Uint8Array;
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}): Promise<{ sha256: string; encryptedPath: string; schemaDigest: string }> {
  const { claim, execution, fence, signal } = input;
  if (
    !execution.resource.runtimeIdentity ||
    execution.resource.id === claim.id ||
    execution.resource.environment !== "development" ||
    execution.resource.provider !== "local"
  )
    throw new Error("Backup requires a separate ready local resource");
  const sourceScope = {
    resourceId: claim.resourceId,
    projectId: claim.projectId,
    environment: "development" as const,
  };
  const temporaryScope = { ...sourceScope, resourceId: claim.id };
  const temporaryCredentials = createDatabaseCredentials(claim.id);
  const temporaryFence: DatabaseRuntimeFence = {
    ...fence,
    acknowledgeEffect: (effect) => fence.acknowledgeEffect(effect),
  };
  let temporaryStarted = false;
  try {
    const source = {
      scope: sourceScope,
      database: execution.resource.runtimeIdentity,
      operationId: claim.id,
      credentials: execution.credentials,
      administratorBundle: input.bundle,
      fence,
      signal,
    };
    const schemaDigest = await inspectManagedDatabaseSchema(source);
    const archive = await captureManagedDatabaseBackup({
      ...source,
      role: execution.credentials.migrator,
    });
    const key = await loadDatabaseKey(
      join(input.directory, "database-keys"),
      true,
    );
    const context = {
      resourceId: claim.resourceId,
      backupId: claim.id,
      schemaDigest,
    };
    const saved = await sealDatabaseBackup(
      input.directory,
      key,
      context,
      archive,
    );
    const verifiedBytes = await openDatabaseBackup(
      input.directory,
      key,
      context,
      saved.sha256,
    );
    await fence.assertHeld();
    signal.throwIfAborted();
    temporaryStarted = true;
    const database = await createManagedDatabase({
      scope: temporaryScope,
      operationId: claim.id,
      administrator: temporaryCredentials.administrator,
      fence: temporaryFence,
      signal,
    });
    const temporary = {
      scope: temporaryScope,
      database,
      operationId: claim.id,
      credentials: temporaryCredentials,
      administratorBundle: input.bundle,
      fence: temporaryFence,
      signal,
    };
    await provisionManagedDatabaseRoles(temporary);
    await restoreDisposableDatabaseBackup({
      ...temporary,
      role: temporaryCredentials.migrator,
      archive: verifiedBytes,
    });
    if (
      (await inspectManagedDatabaseSchema(temporary)) !== schemaDigest ||
      (await inspectManagedDatabaseSchema(source)) !== schemaDigest
    )
      throw new Error(
        "Restored/source schema or migration journal changed during verification",
      );
    await cleanupDisposableDatabase(temporaryScope, claim.id, claim.resourceId);
    temporaryStarted = false;
    await fence.assertHeld();
    signal.throwIfAborted();
    return { ...saved, schemaDigest };
  } finally {
    if (temporaryStarted)
      await cleanupDisposableDatabase(
        temporaryScope,
        claim.id,
        claim.resourceId,
      );
  }
}
