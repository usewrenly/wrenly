// Restores a verified backup into a separate disposable database before applying reviewed source.
import {
  createManagedDatabase,
  cleanupDisposableDatabase,
  startDatabaseSocket,
  cleanupDatabaseSocket,
  type DatabaseSocketIdentity,
  type DatabaseRuntimeFence,
} from "@wrenly/sandbox";
import {
  provisionManagedDatabaseRoles,
  inspectManagedDatabaseSchema,
  enforceManagedDatabaseRolePolicy,
  terminateManagedDatabaseSessions,
} from "@wrenly/sandbox/database-administrator";
import { restoreDisposableDatabaseBackup } from "@wrenly/sandbox/database-backup-runtime";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { runDatabaseSocketWorker } from "@wrenly/sandbox/database-socket-worker";
import { createDatabaseCredentials } from "./database-contract";
import { z } from "zod";
import { runLaravelDatabaseMigrations } from "@wrenly/sandbox/laravel-migrations";

const Identifier = z.string().uuid();
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** Rehearses frozen framework migrations on a separate restore; it never connects to the persistent resource. */
export async function rehearseDatabaseMigrations(input: {
  projectId: string;
  resourceId: string;
  operationId: string;
  archive: Uint8Array;
  backupSchemaDigest: string;
  files: Array<{ path: string; content: string }>;
  migrationDigest: string;
  framework?: "nextjs" | "laravel";
  administratorBundle: Uint8Array;
  migrationBundle: Uint8Array;
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}): Promise<{ migrationDigest: string; schemaDigest: string }> {
  const migrations = readAppDatabaseManifest(input.files, input.framework ?? "nextjs");
  if (
    ![input.projectId, input.resourceId, input.operationId].every(
      (value) => Identifier.safeParse(value).success,
    ) ||
    input.archive.byteLength > MAX_ARCHIVE_BYTES ||
    Buffer.from(input.archive.subarray(0, 5)).toString("ascii") !== "PGDMP" ||
    !migrations ||
    migrations.digest !== input.migrationDigest ||
    !/^[a-f0-9]{64}$/.test(input.backupSchemaDigest) ||
    input.resourceId === input.operationId
  )
    throw new Error(
      "Review the frozen migration and verified backup before rehearsal",
    );
  const credentials = createDatabaseCredentials(input.operationId);
  const scope = {
    resourceId: input.operationId,
    projectId: input.projectId,
    environment: "development" as const,
  };
  // Disposable identities must never replace the persistent resource's saved identity.
  const fence: DatabaseRuntimeFence = {
    ...input.fence,
    acknowledgeEffect: (effect) => input.fence.acknowledgeEffect(effect),
  };
  let started = false;
  let socket: DatabaseSocketIdentity | undefined;
  try {
    await fence.assertHeld();
    input.signal.throwIfAborted();
    started = true;
    const database = await createManagedDatabase({
      scope,
      operationId: input.operationId,
      administrator: credentials.administrator,
      fence,
      signal: input.signal,
    });
    const administrator = {
      scope,
      database,
      operationId: input.operationId,
      credentials,
      administratorBundle: input.administratorBundle,
      fence,
      signal: input.signal,
    };
    await provisionManagedDatabaseRoles(administrator);
    await restoreDisposableDatabaseBackup({
      ...administrator,
      role: credentials.migrator,
      archive: input.archive,
    });
    if (
      (await inspectManagedDatabaseSchema(administrator)) !==
      input.backupSchemaDigest
    )
      throw new Error("The restored backup does not match its verified schema");
    socket = await startDatabaseSocket({
      scope,
      database,
      socketId: input.operationId,
      role: { kind: "migrator", ...credentials.migrator },
      fence,
      signal: input.signal,
    });
    if (input.framework === "laravel") {
      await runLaravelDatabaseMigrations({
        scope, socket, operationId: input.operationId, files: input.files,
        migrationDigest: input.migrationDigest, journalBundle: input.migrationBundle, role: credentials.migrator,
        fence, signal: input.signal,
      });
    } else await runDatabaseSocketWorker({
      kind: "migration",
      scope,
      socket,
      operationId: input.operationId,
      request: {
        resourceId: scope.resourceId,
        ...credentials.migrator,
        digest: migrations.digest,
        paths: migrations.files.map((file) => file.path),
      },
      bundle: input.migrationBundle,
      files: input.files,
      fence,
      signal: input.signal,
    });
    await cleanupDatabaseSocket(socket);
    socket = undefined;
    await terminateManagedDatabaseSessions({
      ...administrator,
      target: "migrator",
    });
    await enforceManagedDatabaseRolePolicy(administrator);
    const schemaDigest = await inspectManagedDatabaseSchema(administrator);
    await cleanupDisposableDatabase(scope, input.operationId, input.resourceId);
    started = false;
    await fence.assertHeld();
    input.signal.throwIfAborted();
    return { migrationDigest: migrations.digest, schemaDigest };
  } finally {
    // Even a failed SQL statement cannot outlive the disposable PostgreSQL resource.
    try {
      if (socket) await cleanupDatabaseSocket(socket);
    } finally {
      if (started)
        await cleanupDisposableDatabase(
          scope,
          input.operationId,
          input.resourceId,
        );
    }
  }
}
