/**
 * COMPONENT: Fresh application database rehearsal
 * PURPOSE: Check saved migrations and a prepared application without connecting to real app data.
 * INPUTS: Saved operation/source/image identities and independent execution/cleanup fences.
 * OUTPUTS: Migration/schema fingerprints and HTTP readiness after disposable cleanup.
 * STEPS: Freeze inputs, create new resource/roles, apply saved migrations through the
 * migrator socket, close migration access, open runtime-only access, check HTTP, clean up.
 * EDGE CASES: Cancellation/unknown effects never restart; cleanup has its own acknowledgement.
 * ERROR STATES: Fixed failure; an HTTP response is not proof of application-specific CRUD.
 */
import { createManagedDatabase, cleanupDisposableDatabase, startDatabaseSocket, cleanupScopedDatabaseSocket,
  type DatabaseRuntimeFence } from "@wrenly/sandbox";
import { provisionManagedDatabaseRoles, inspectManagedDatabaseSchema, enforceManagedDatabaseRolePolicy,
  terminateManagedDatabaseSessions } from "@wrenly/sandbox/database-administrator";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { runDatabaseSocketWorker } from "@wrenly/sandbox/database-socket-worker";
import { runPreparedLaravelDatabaseMigrations } from "@wrenly/sandbox/laravel-migrations";
import { checkDisposableApplicationHttp } from "@wrenly/sandbox/database-application-check";
import { createDatabaseCredentials } from "./database-contract";
import { getDatabaseWorkerBundle } from "./database-worker-bundle";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VALIDATION_TIMEOUT_MS = 300_000;
const HTTP_TIMEOUT_MS = 60_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface DisposableValidationCleanup {
  assertHeld: () => Promise<void>;
  beforeCleanup: (kind: "application" | "socket" | "database", id: string) => Promise<void>;
  acknowledgeCleanup: (kind: "application" | "socket" | "database", id: string) => Promise<void>;
}

/** Internal only: image preparation must finish before this starts. No product claim/controller calls this yet. */
export async function validateFreshDatabaseApplication(request: {
  framework: "nextjs" | "laravel";
  projectId: string;
  sourceResourceId: string;
  operationId: string;
  files: Array<{ path: string; content: string }>;
  migrationDigest: string;
  imageId: string;
  /** Time left from the entire build deadline, including prior artifact preparation. */
  remainingMs: number;
  fence: DatabaseRuntimeFence;
  cleanup: DisposableValidationCleanup;
  signal: AbortSignal;
}): Promise<{ migrationDigest: string; schemaDigest: string; httpReady: true }> {
  const input = { ...request, files: request.files.map(file => ({ ...file })) };
  const migrations = readAppDatabaseManifest(input.files, input.framework);
  if (![input.projectId, input.sourceResourceId, input.operationId].every(id => UUID.test(id)) ||
      input.sourceResourceId === input.operationId || !DIGEST.test(input.migrationDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.imageId) || Buffer.byteLength(JSON.stringify(input.files)) > MAX_SOURCE_BYTES ||
      !Number.isSafeInteger(input.remainingMs) || input.remainingMs < 1 || input.remainingMs > VALIDATION_TIMEOUT_MS ||
      !migrations || migrations.digest !== input.migrationDigest)
    throw new Error("Review the saved application migration identity before validation.");
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Disposable validation cancelled."));
  const timer = setTimeout(abort, input.remainingMs);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const signal = controller.signal;
  const deadline = Date.now() + input.remainingMs;
  const scope = { projectId: input.projectId, resourceId: input.operationId, environment: "development" as const };
  const credentials = createDatabaseCredentials(input.operationId);
  // Never save a disposable identity as the source resource's durable runtime identity.
  const fence: DatabaseRuntimeFence = { ...input.fence,
    assertHeld: async () => { signal.throwIfAborted(); await input.fence.assertHeld(); signal.throwIfAborted(); },
    acknowledgeEffect: effect => input.fence.acknowledgeEffect(effect) };
  let databaseAttempted = false;
  let socketAttempted = false;
  let failed = false;
  let cleanupFailed = false;
  let result: { migrationDigest: string; schemaDigest: string; httpReady: true } | undefined;
  let phase = "trusted bundle preparation";
  const closeSocket = async (): Promise<void> => {
    const id = `wrenly-database-socket-${input.operationId}`;
    await input.cleanup.assertHeld();
    await input.cleanup.beforeCleanup("socket", id);
    await input.cleanup.assertHeld();
    await cleanupScopedDatabaseSocket(scope, input.operationId);
    await input.cleanup.acknowledgeCleanup("socket", id);
    socketAttempted = false;
  };
  try {
    await fence.assertHeld();
    const [administratorBundle, migrationBundle, bootstrapBundle] = await Promise.all([
      getDatabaseWorkerBundle("administrator"), getDatabaseWorkerBundle("migration"), getDatabaseWorkerBundle("application"),
    ]);
    await fence.assertHeld();
    phase = "database creation";
    databaseAttempted = true;
    const database = await createManagedDatabase({ scope, operationId: input.operationId,
      administrator: credentials.administrator, fence, signal });
    const administrator = { scope, database, operationId: input.operationId, credentials,
      administratorBundle, fence, signal };
    phase = "role provisioning";
    await provisionManagedDatabaseRoles(administrator);
    phase = "migrator socket readiness";
    socketAttempted = true;
    const migratorSocket = await startDatabaseSocket({ scope, database, socketId: input.operationId,
      role: { kind: "migrator", ...credentials.migrator }, fence, signal });
    phase = "reviewed migrations";
    if (input.framework === "laravel") await runPreparedLaravelDatabaseMigrations({
      scope, socket: migratorSocket, operationId: input.operationId, files: input.files,
      migrationDigest: migrations.digest, journalBundle: migrationBundle, role: credentials.migrator,
      preparedImage: { imageId: input.imageId, preparationId: input.operationId, migrationDigest: migrations.digest },
      fence, signal,
    });
    else await runDatabaseSocketWorker({ kind: "migration", scope, socket: migratorSocket,
      operationId: input.operationId, request: { resourceId: scope.resourceId, ...credentials.migrator,
        digest: migrations.digest, paths: migrations.files.map(file => file.path) },
      bundle: migrationBundle, files: input.files, fence, signal });
    phase = "migration access cleanup";
    await closeSocket();
    await terminateManagedDatabaseSessions({ ...administrator, target: "migrator" });
    await enforceManagedDatabaseRolePolicy(administrator);
    phase = "schema inspection";
    const schemaDigest = await inspectManagedDatabaseSchema(administrator);
    phase = "runtime socket readiness";
    socketAttempted = true;
    const runtimeSocket = await startDatabaseSocket({ scope, database, socketId: input.operationId,
      role: { kind: "runtime", ...credentials.runtime }, fence, signal });
    phase = "application HTTP readiness";
    await checkDisposableApplicationHttp({ scope, sourceResourceId: input.sourceResourceId,
      operationId: input.operationId, framework: input.framework, imageId: input.imageId,
      socket: runtimeSocket, role: credentials.runtime, bootstrapBundle,
      lifetimeMs: Math.min(HTTP_TIMEOUT_MS, Math.max(1, deadline - Date.now())), fence, signal,
      cleanup: { assertHeld: input.cleanup.assertHeld,
        beforeCleanup: id => input.cleanup.beforeCleanup("application", id),
        acknowledgeCleanup: id => input.cleanup.acknowledgeCleanup("application", id) } });
    phase = "runtime schema comparison";
    if (await inspectManagedDatabaseSchema(administrator) !== schemaDigest)
      throw new Error("Application runtime changed its reviewed schema.");
    result = { migrationDigest: migrations.digest, schemaDigest, httpReady: true };
  } catch { failed = true; }
  finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    try {
      if (socketAttempted) await closeSocket();
      if (databaseAttempted) {
        const id = `wrenly-database-${input.operationId}`;
        await input.cleanup.assertHeld();
        await input.cleanup.beforeCleanup("database", id);
        await input.cleanup.assertHeld();
        await cleanupDisposableDatabase(scope, input.operationId, input.sourceResourceId);
        await input.cleanup.acknowledgeCleanup("database", id);
      }
    } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new Error("Disposable validation cleanup requires reconciliation.");
  if (failed || !result) throw new Error(`Disposable database application validation failed during ${phase}.`);
  await input.fence.assertHeld();
  input.signal.throwIfAborted();
  return result;
}
