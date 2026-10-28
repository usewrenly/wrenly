// Applies a reviewed revision only after verified backup rehearsal; uncertain SQL and cleanup retain separate acknowledgements.
import { join } from "node:path";
import { runLaravelDatabaseMigrations } from "@wrenly/sandbox/laravel-migrations";
import type { db } from "@wrenly/db";
import {
  startDatabaseSocket,
  cleanupScopedDatabaseSocket,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import {
  inspectManagedDatabaseSchema,
  enforceManagedDatabaseRolePolicy,
  terminateManagedDatabaseSessions,
} from "@wrenly/sandbox/database-administrator";
import { runDatabaseSocketWorker } from "@wrenly/sandbox/database-socket-worker";
import {
  loadDatabaseMigrationReview,
  saveDatabaseMigrationRehearsal,
  saveVerifiedDatabaseMigration,
  type DatabaseClaim,
  type loadDatabaseExecution,
} from "./database-store";
import { loadDatabaseKey } from "./database-secrets";
import { openDatabaseBackup } from "./database-backup-storage";
import { rehearseDatabaseMigrations } from "./database-migration-rehearsal";

const CLEANUP_TIMEOUT_MS = 20_000;

/** Applies only an owner-admitted frozen review; unknown SQL is preserved independently of cleanup. */
export async function executeReviewedDatabaseMigrations(input: {
  database: typeof db;
  claim: DatabaseClaim;
  execution: Awaited<ReturnType<typeof loadDatabaseExecution>>;
  directory: string;
  administratorBundle: Uint8Array;
  migrationBundle: Uint8Array;
  fence: DatabaseRuntimeFence;
  cleanupFence: DatabaseRuntimeFence;
  signal: AbortSignal;
}): Promise<void> {
  const { claim, execution, fence, signal } = input;
  const identity = execution.resource.runtimeIdentity;
  if (
    !identity ||
    execution.resource.environment !== "development" ||
    execution.resource.provider !== "local" ||
    execution.resource.status !== "ready" ||
    execution.resource.revision !== execution.operation.expectedRevision
  )
    throw new Error("The reviewed local database revision is no longer ready");
  const frozen = await loadDatabaseMigrationReview(input.database, claim);
  const beforeSchemaDigest = frozen.review.beforeSchemaDigest;
  if (!beforeSchemaDigest) throw new Error("Missing reviewed backup schema");
  const key = await loadDatabaseKey(
    join(input.directory, "database-keys"),
    true,
  );
  const archive = await openDatabaseBackup(
    input.directory,
    key,
    {
      resourceId: claim.resourceId,
      backupId: frozen.backup.id,
      schemaDigest: beforeSchemaDigest,
    },
    frozen.backup.sha256,
  );
  const rehearsal = await rehearseDatabaseMigrations({
    projectId: claim.projectId,
    resourceId: claim.resourceId,
    operationId: claim.id,
    archive,
    backupSchemaDigest: beforeSchemaDigest,
    files: frozen.files,
    migrationDigest: frozen.review.digest,
    framework: frozen.framework,
    administratorBundle: input.administratorBundle,
    migrationBundle: input.migrationBundle,
    fence,
    signal,
  });
  await saveDatabaseMigrationRehearsal(
    input.database,
    claim,
    rehearsal.schemaDigest,
  );
  const scope = {
    resourceId: claim.resourceId,
    projectId: claim.projectId,
    environment: "development" as const,
  };
  const administrator = {
    scope,
    database: identity,
    operationId: claim.id,
    credentials: execution.credentials,
    administratorBundle: input.administratorBundle,
    fence,
    signal,
  };
  if (
    (await inspectManagedDatabaseSchema(administrator)) !== beforeSchemaDigest
  )
    throw new Error("The persistent schema changed since backup verification");
  let socketIntent = false;
  const socketFence: DatabaseRuntimeFence = {
    ...fence,
    beforeEffect: async (effect) => {
      await fence.beforeEffect(effect);
      if (effect.kind === "create-socket") socketIntent = true;
    },
  };
  try {
    const socket = await startDatabaseSocket({
      scope,
      database: identity,
      socketId: claim.id,
      role: { kind: "migrator", ...execution.credentials.migrator },
      fence: socketFence,
      signal,
    });
    if (frozen.framework === "laravel") {
      await runLaravelDatabaseMigrations({
        scope, socket, operationId: claim.id, files: frozen.files,
        migrationDigest: frozen.review.digest, journalBundle: input.migrationBundle, role: execution.credentials.migrator,
        fence, signal,
      });
    } else await runDatabaseSocketWorker({
      kind: "migration",
      scope,
      socket,
      operationId: claim.id,
      request: {
        resourceId: claim.resourceId,
        ...execution.credentials.migrator,
        digest: frozen.review.digest,
        paths: frozen.review.manifest.map((file) => file.path),
      },
      bundle: input.migrationBundle,
      files: frozen.files,
      fence,
      signal,
    });
  } finally {
    if (socketIntent) {
      await cleanupScopedDatabaseSocket(scope, claim.id);
      await terminateManagedDatabaseSessions({
        ...administrator,
        target: "migrator",
        fence: input.cleanupFence,
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
    }
  }
  await fence.assertHeld();
  await enforceManagedDatabaseRolePolicy(administrator);
  const schemaDigest = await inspectManagedDatabaseSchema(administrator);
  if (schemaDigest !== rehearsal.schemaDigest)
    throw new Error(
      "The persistent migration result differs from its rehearsal",
    );
  await saveVerifiedDatabaseMigration(input.database, claim, schemaDigest);
}
