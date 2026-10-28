/** Connects saved database previews to the existing bounded scheduler; construction starts no work. */
import type { db } from "@wrenly/db";
import { assertPreviewRuntimeRunning, type PreviewRuntimeResult } from "@wrenly/sandbox";
import type { PreviewWorkerDependencies } from "../../previews/execution/preview-worker";
import type { PreviewWorkerConfiguration } from "../../previews/execution/preview-worker-services";
import {
  renewPreviewLease, updatePreviewProgress, interruptPreview, failPreview,
  PreviewClaimLostError, type PreviewClaim,
} from "../../previews/persistence/preview-store";
import { claimNextDatabasePreview } from "../bindings/preview-claim";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { AppDatabaseError } from "../database-contract";
import { preparePreviewDatabaseArtifact } from "./runtime-preparation";
import { openPreviewDatabaseSocket } from "./runtime-socket";
import { startPreviewDatabaseApplication } from "./runtime-startup";
import { cleanupPreviewDatabaseRuntime, type PreviewDatabaseCleanupAdapters } from "./runtime-cleanup";
import { beginPreviewDatabaseCleanup } from "./cleanup-store";
import { findDatabasePreviewRecovery, revokeDatabasePreviewForCleanup } from "./runtime-recovery";
import { CLEANUP_DEADLINE_MS } from "./runtime-policy";

const MAX_PREVIEW_LIFETIME_MS = 60 * 60 * 1000;

export interface DatabasePreviewExecutionLocks {
  acquire: (claim: PreviewClaim) => Promise<void>;
  assertHeld: (claim: PreviewClaim) => void | Promise<void>;
  release: (claim: PreviewClaim) => Promise<void>;
  /** Acquire the dead executor's kernel lock and allow in-flight Docker requests to settle. */
  assertExternalQuiescent: (claim: PreviewClaim) => Promise<void>;
}
export interface DatabasePreviewWorkerAdapters {
  prepare?: Parameters<typeof preparePreviewDatabaseArtifact>[4];
  socket?: Parameters<typeof openPreviewDatabaseSocket>[5];
  start?: Parameters<typeof startPreviewDatabaseApplication>[5];
  bundle?: Parameters<typeof startPreviewDatabaseApplication>[6];
  check?: (claim: PreviewClaim, runtime: PreviewRuntimeResult) => Promise<void>;
  cleanup?: PreviewDatabaseCleanupAdapters;
}
export interface DatabasePreviewHandle { claim: PreviewClaim; runtime: PreviewRuntimeResult }
export interface DatabasePreviewWorkerServices {
  dependencies: PreviewWorkerDependencies<DatabasePreviewHandle>;
  runtime: (previewId: string) => { ingressUrl: string; capability: string } | null;
}

/** Inject real kernel-lock ownership before use. No HTTP routes, worker loop or automatic cleanup retry is installed here. */
export function createDatabasePreviewWorkerServices(
  database: typeof db,
  configuration: PreviewWorkerConfiguration & { directory: string; lifetimeMs: number },
  execution: DatabasePreviewExecutionLocks,
  adapters: DatabasePreviewWorkerAdapters = {},
): DatabasePreviewWorkerServices {
  if (!Number.isSafeInteger(configuration.lifetimeMs) || configuration.lifetimeMs < 1 || configuration.lifetimeMs > MAX_PREVIEW_LIFETIME_MS)
    throw new Error("Database preview lifetime must be bounded to one hour.");
  const live = new Map<string, DatabasePreviewHandle>();
  const ready = new Set<string>();
  const owned = new Set<string>();
  const failedCleanup = new Set<string>();
  const key = (claim: PreviewClaim): string => `${claim.previewId}:${claim.token}`;
  const kernel = (claim: PreviewClaim): (() => Promise<void>) => async () => { await execution.assertHeld(claim); };
  const cleanup = async (claim: PreviewClaim): Promise<void> => {
    live.delete(claim.previewId);
    ready.delete(claim.previewId);
    if (failedCleanup.has(key(claim))) throw new AppDatabaseError(409, "Explicit database preview cleanup recovery is required.");
    await execution.acquire(claim);
    const held = kernel(claim);
    try {
      await held();
      if (owned.has(key(claim))) {
        // The scheduler has awaited preparation before calling cleanup; revocation cannot strand owned resources.
        try { await interruptPreview(database, claim); }
        catch (error) { if (!(error instanceof PreviewClaimLostError)) throw error; }
      }
      const needsCleanup = await revokeDatabasePreviewForCleanup(database, claim, held);
      if (needsCleanup) {
        const claimForCleanup = await beginPreviewDatabaseCleanup(database, claim, crypto.randomUUID(), held);
        await cleanupPreviewDatabaseRuntime(database, claimForCleanup, configuration.directory,
          AbortSignal.timeout(CLEANUP_DEADLINE_MS), held, adapters.cleanup);
      }
      owned.delete(key(claim));
      await execution.release(claim);
    } catch {
      // Do not turn the scheduler's next poll into a retry of an unknown cleanup effect.
      failedCleanup.add(key(claim));
      throw new AppDatabaseError(409, "Database preview cleanup is unconfirmed. Preserve its reservation for explicit recovery.");
    }
  };
  const dependencies: PreviewWorkerDependencies<DatabasePreviewHandle> = {
    claim: async () => {
      const claim = await claimNextDatabasePreview(database);
      if (!claim) return null;
      await execution.acquire(claim);
      await execution.assertHeld(claim);
      owned.add(key(claim));
      return claim;
    },
    renew: async (claim) => {
      await execution.assertHeld(claim);
      await assertPreviewDatabaseBinding(database, claim);
      await renewPreviewLease(database, claim);
      await assertPreviewDatabaseBinding(database, claim);
      await execution.assertHeld(claim);
    },
    prepare: async (claim, signal) => {
      const held = kernel(claim);
      await preparePreviewDatabaseArtifact(database, claim, signal, held, adapters.prepare);
      await openPreviewDatabaseSocket(database, claim, configuration.directory, signal, held, adapters.socket);
      const runtime = await startPreviewDatabaseApplication(database, claim, {
        directory: configuration.directory, lifetimeMs: configuration.lifetimeMs,
        ingressBundle: configuration.ingressBundle, ingress: configuration.ingressFor(claim),
      }, signal, held, adapters.start, adapters.bundle);
      const handle = { claim, runtime };
      live.set(claim.previewId, handle);
      return handle;
    },
    ready: async (claim) => {
      await execution.assertHeld(claim);
      if (live.get(claim.previewId)?.claim.token !== claim.token)
        throw new AppDatabaseError(409, "The acknowledged database preview runtime is unavailable.");
      await assertPreviewDatabaseBinding(database, claim);
      await updatePreviewProgress(database, claim, { type: "ready" });
      await execution.assertHeld(claim);
      ready.add(claim.previewId);
    },
    check: async ({ claim, runtime }) => {
      await execution.assertHeld(claim);
      await assertPreviewDatabaseBinding(database, claim);
      if (adapters.check) await adapters.check(claim, runtime);
      else await assertPreviewRuntimeRunning({ previewId: claim.previewId, projectId: claim.projectId,
        buildId: claim.buildId, claimToken: claim.token }, runtime);
      await execution.assertHeld(claim);
    },
    fail: (claim) => failPreview(database, claim, "Database preview preparation or runtime failed. Review this revision before preparing again."),
    interrupt: (claim) => interruptPreview(database, claim),
    cleanup,
    assertExternalQuiescent: (claim) => execution.assertExternalQuiescent(claim),
    reconcile: async (quiesce) => {
      const candidate = await findDatabasePreviewRecovery(database);
      if (!candidate) return null;
      if (failedCleanup.has(key(candidate))) throw new AppDatabaseError(409, "Explicit cleanup recovery is required.");
      // Never wait for an executor while holding its journal/preview transaction locks.
      await quiesce(candidate);
      await cleanup(candidate);
      return candidate;
    },
  };
  return { dependencies, runtime: (id) => {
    const handle = live.get(id);
    return handle && ready.has(id) ? { ingressUrl: handle.runtime.ingressUrl,
      capability: configuration.ingressFor(handle.claim).capability } : null;
  } };
}
