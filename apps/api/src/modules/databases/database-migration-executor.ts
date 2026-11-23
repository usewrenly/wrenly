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
import type { DatabaseClientScope } from "@wrenly/sandbox/database-resource-policy";
import type { DatabaseSocketIdentity } from "@wrenly/sandbox";
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
  await executeFrozenDatabaseMigrations({
    ...input,
    scope,
    role: execution.credentials.migrator,
    inspect: () => inspectManagedDatabaseSchema(administrator),
    enforcePolicy: () => enforceManagedDatabaseRolePolicy(administrator),
    openSocket: (socketFence) =>
      startDatabaseSocket({
        scope,
        database: identity,
        socketId: claim.id,
        role: { kind: "migrator", ...execution.credentials.migrator },
        fence: socketFence,
        signal,
      }),
    closeSocket: async () => {
      await cleanupScopedDatabaseSocket(scope, claim.id);
      await terminateManagedDatabaseSessions({
        ...administrator,
        target: "migrator",
        fence: input.cleanupFence,
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
    },
  });
}

/** Shared reviewed-migration sequence; provider adapters supply exact-source inspection and isolated socket lifecycle. */
export async function executeFrozenDatabaseMigrations(input: {
  database: typeof db;
  claim: DatabaseClaim;
  directory: string;
  administratorBundle: Uint8Array;
  migrationBundle: Uint8Array;
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
  scope: DatabaseClientScope;
  role: { user: string; password: string };
  inspect: () => Promise<string>;
  enforcePolicy: () => Promise<void>;
  openSocket: (fence: DatabaseRuntimeFence) => Promise<DatabaseSocketIdentity>;
  closeSocket: () => Promise<void>;
}): Promise<void> {
  const { claim, fence, signal, scope } = input;
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
  if ((await input.inspect()) !== beforeSchemaDigest)
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
    const socket = await input.openSocket(socketFence);
    if (frozen.framework === "laravel") {
      await runLaravelDatabaseMigrations({
        scope,
        socket,
        operationId: claim.id,
        files: frozen.files,
        migrationDigest: frozen.review.digest,
        journalBundle: input.migrationBundle,
        role: input.role,
        fence,
        signal,
      });
    } else
      await runDatabaseSocketWorker({
        kind: "migration",
        scope,
        socket,
        operationId: claim.id,
        request: {
          resourceId: claim.resourceId,
          ...input.role,
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
      await input.closeSocket();
    }
  }
  await fence.assertHeld();
  await input.enforcePolicy();
  const schemaDigest = await input.inspect();
  if (schemaDigest !== rehearsal.schemaDigest)
    throw new Error(
      "The persistent migration result differs from its rehearsal",
    );
  await saveVerifiedDatabaseMigration(input.database, claim, schemaDigest);
}
