/** Resumes one stopped database preview's cleanup without repeating confirmed removals. */
import type { db } from "@wrenly/db";
import { AppDatabaseError } from "../database-contract";
import type { RuntimeKernelFence } from "./runtime-store";
import {
  assertPreviewDatabaseCleanup,
  nextPreviewDatabaseCleanup,
  renewPreviewDatabaseCleanup,
  finishPreviewDatabaseCleanup,
  type PreviewDatabaseCleanupClaim,
} from "./cleanup-store";
import { cleanupPreviewDatabaseApplication } from "./runtime-application";
import { cleanupPreviewDatabaseSocket } from "./runtime-socket";
import { cleanupPreviewDatabaseSessions } from "./runtime-sessions";
import { cleanupPreviewDatabaseArtifact } from "./runtime-artifact";

/** Trusted adapter overrides let acceptance use real storage without touching an existing runtime. */
export interface PreviewDatabaseCleanupAdapters {
  application?: Parameters<typeof cleanupPreviewDatabaseApplication>[3];
  socket?: Parameters<typeof cleanupPreviewDatabaseSocket>[3];
  sessions?: Parameters<typeof cleanupPreviewDatabaseSessions>[5];
  administratorBundle?: Parameters<typeof cleanupPreviewDatabaseSessions>[6];
  artifact?: Parameters<typeof cleanupPreviewDatabaseArtifact>[3];
}

/** The caller owns cleanup authority and the kernel lock; errors retain both saved progress and capacity. */
export async function cleanupPreviewDatabaseRuntime(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  directory: string,
  signal: AbortSignal,
  assertKernel: RuntimeKernelFence,
  adapters: PreviewDatabaseCleanupAdapters = {},
): Promise<void> {
  const kernel = async (): Promise<void> => {
    signal.throwIfAborted();
    await assertKernel();
    signal.throwIfAborted();
  };
  const held = (): Promise<void> =>
    assertPreviewDatabaseCleanup(database, claim, kernel);
  try {
    for (;;) {
      await held();
      const next = await nextPreviewDatabaseCleanup(database, claim, kernel);
      if (!next) {
        await finishPreviewDatabaseCleanup(database, claim, kernel);
        return;
      }
      // Renew between effects only. Neither renewal nor recovery extends the original deadline.
      await renewPreviewDatabaseCleanup(database, claim, kernel);
      switch (next) {
        case "application":
          await cleanupPreviewDatabaseApplication(database, claim, kernel, adapters.application);
          break;
        case "socket":
          await cleanupPreviewDatabaseSocket(database, claim, kernel, adapters.socket);
          break;
        case "sessions":
          await cleanupPreviewDatabaseSessions(database, claim, directory, signal, kernel,
            adapters.sessions, adapters.administratorBundle);
          break;
        case "artifact":
          await cleanupPreviewDatabaseArtifact(database, claim, kernel, adapters.artifact);
          break;
      }
    }
  } catch {
    // An error is not evidence that the external effect did not happen. Recovery must be explicit.
    throw new AppDatabaseError(409,
      "Preview cleanup is unconfirmed. Preserve its saved progress and reservation for explicit recovery.");
  }
}
