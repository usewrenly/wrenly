/**
 * COMPONENT: Offline Laravel migration execution
 * PURPOSE: Prepare or reuse reviewed source without database credentials, then run Artisan
 * through exactly one authenticated socket with IP networking disabled.
 * INPUTS: Saved source/digest, migrator socket/role and caller's durable execution fence.
 * OUTPUTS: Confirmed completion after helper/image cleanup, or explicit failure.
 * STEPS: Recheck source, prepare or accept the operation's isolated artifact, recheck
 * fence, run fixed bridge and independently verify the native journal. The preparing
 * caller owns image removal; the compatibility wrapper removes its own image. Caller
 * owns verified backups, rehearsal, schema comparison and durable recovery.
 * EDGE CASES: Abort/lost fence never authorizes another attempt; no resource adoption.
 * ERROR STATES: Preparation/execution/cleanup uncertainty remains a failed operation.
 */
import Docker from "dockerode";
import { prepareDatabaseValidationArtifact, RuntimeArtifactError } from "../artifacts/runtime-artifact";
import { readAppDatabaseManifest } from "./database-manifest";
import { validateLaravelSource } from "../source-policy/laravel-runtime";
import { runDatabaseSocketWorker } from "./database-socket-worker";
import { DatabaseRuntimeError, type DatabaseRuntimeFence } from "./database-runtime";
import type { DatabaseSocketIdentity } from "./database-socket";
import type { ManagedDatabaseScope } from "./database-resource-policy";

const MAX_JOURNAL_BUNDLE_BYTES = 2 * 1024 * 1024;
const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });

interface LaravelMigrationInput {
  scope: ManagedDatabaseScope;
  socket: DatabaseSocketIdentity;
  operationId: string;
  files: Array<{ path: string; content: string }>;
  migrationDigest: string;
  journalBundle: Uint8Array;
  role: { user: string; password: string };
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}

/** Executes an already prepared revision; caller owns its image and must prepare it before starting the test database. */
export async function runPreparedLaravelDatabaseMigrations(request: LaravelMigrationInput & {
  preparedImage: { imageId: string; preparationId: string; migrationDigest: string };
}): Promise<void> {
  const input = { ...request, scope: { ...request.scope }, socket: { ...request.socket },
    role: { ...request.role }, preparedImage: { ...request.preparedImage } };
  if (!input.journalBundle.byteLength || input.journalBundle.byteLength > MAX_JOURNAL_BUNDLE_BYTES)
    throw new Error("Trusted Laravel journal verifier is unavailable.");
  validateLaravelSource(input.files);
  const manifest = readAppDatabaseManifest(input.files, "laravel");
  if (!manifest || manifest.digest !== input.migrationDigest ||
      input.preparedImage.migrationDigest !== manifest.digest ||
      input.preparedImage.preparationId !== input.operationId ||
      !/^sha256:[a-f0-9]{64}$/.test(input.preparedImage.imageId))
    throw new Error("Reviewed Laravel application source changed.");
  const bundle = input.journalBundle.slice();
  const paths = [...manifest.manifest.database.migrations];
  const preparedImage = { ...input.preparedImage };
  const role = { ...input.role };
  await input.fence.assertHeld();
  input.signal.throwIfAborted();
  await runDatabaseSocketWorker({
    kind: "migration", scope: input.scope, socket: input.socket,
    operationId: input.operationId,
    request: { resourceId: input.scope.resourceId, ...role, paths },
    bundle: new Uint8Array(),
    laravel: { imageId: preparedImage.imageId, preparationId: preparedImage.preparationId },
    fence: input.fence, signal: input.signal,
  });
  await runDatabaseSocketWorker({
    kind: "migration", scope: input.scope, socket: input.socket,
    operationId: input.operationId,
    request: { framework: "laravel", resourceId: input.scope.resourceId,
      ...role, digest: input.migrationDigest, paths },
    bundle, fence: input.fence, signal: input.signal,
  });
}

/** Internal compatibility path: prepares its own image; success is not persistent migration approval. */
export async function runLaravelDatabaseMigrations(input: LaravelMigrationInput): Promise<void> {
  if (!input.journalBundle.byteLength || input.journalBundle.byteLength > MAX_JOURNAL_BUNDLE_BYTES)
    throw new Error("Trusted Laravel journal verifier is unavailable.");
  validateLaravelSource(input.files);
  const manifest = readAppDatabaseManifest(input.files, "laravel");
  if (!manifest || manifest.digest !== input.migrationDigest)
    throw new Error("Reviewed Laravel application source changed.");
  // Copy caller-owned data before any await so later edits cannot retarget preparation.
  const files = input.files.map(file => ({ ...file }));
  const effect = { kind: "apply-migrations" as const, id: `wrenly-laravel-preparation-${input.operationId}` };
  let imageId: string | undefined;
  try {
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    await input.fence.beforeEffect(effect);
    const artifact = await prepareDatabaseValidationArtifact({
      deploymentId: input.operationId,
      stack: "laravel", migrationDigest: manifest.digest, files, signal: input.signal,
      beforeEffect: async () => {
        await input.fence.assertHeld();
        input.signal.throwIfAborted();
      },
    });
    imageId = artifact.imageId;
    await input.fence.acknowledgeEffect(effect);
    await runPreparedLaravelDatabaseMigrations({ ...input, files,
      preparedImage: { imageId, preparationId: input.operationId, migrationDigest: manifest.digest } });
  } catch (error) {
    if (error instanceof RuntimeArtifactError)
      throw new DatabaseRuntimeError(`Laravel preparation: ${error.phase}`);
    throw error;
  } finally {
    // Never hide uncertain cleanup behind a successful migration marker.
    if (imageId) await docker.getImage(imageId).remove({ force: false });
  }
}
