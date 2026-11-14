/** Bounded idempotent cleanup only removes objects already tombstoned by durable metadata. */
import { logger } from "../../lib/logger";
const CLEANUP_INTERVAL_MS = 60_000;
export interface AttachmentCleanupDependencies {
  expire(): Promise<unknown>;
  candidates(
    afterId?: string,
  ): Promise<Array<{ id: string; objectId: string }>>;
  remove(objectId: string): Promise<void>;
}
/** One pass has one bounded candidate page; it never scans arbitrary filesystem names. */
export async function cleanupAttachmentPage(
  dependencies: AttachmentCleanupDependencies,
  afterId?: string,
): Promise<string | undefined> {
  await dependencies.expire();
  const candidates = await dependencies.candidates(afterId);
  for (const candidate of candidates)
    await dependencies.remove(candidate.objectId);
  return candidates.length ? candidates[candidates.length - 1]!.id : undefined;
}
/** Starts explicitly with API lifecycle; shutdown waits for any pending unlink/database work. */
export function startAttachmentCleanup(
  dependencies: AttachmentCleanupDependencies,
): { stop(): Promise<void> } {
  let stopped = false;
  let cursor: string | undefined;
  let running: Promise<void> | undefined;
  const tick = (): void => {
    if (stopped || running) return;
    running = cleanupAttachmentPage(dependencies, cursor)
      .then((next) => {
        cursor = next;
      })
      .catch((error) => {
        logger.error("Attachment cleanup could not be confirmed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, CLEANUP_INTERVAL_MS);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
