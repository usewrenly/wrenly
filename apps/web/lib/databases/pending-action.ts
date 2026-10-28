/** Browser-session recovery stores operation identities only, never credentials, SQL or application rows. */
import { z } from "zod";
import { DatabaseAction, DatabaseRecoveryAction } from "@wrenly/db/app-database-action-contract";
const PendingAction = z.object({ version: z.literal(1), actorId: z.string().min(1).max(256),
  projectId: z.string().uuid(), resourceId: z.string().uuid().nullable(), action: z.union([DatabaseAction, DatabaseRecoveryAction]) }).strict();
export type PendingDatabaseAction = z.infer<typeof PendingAction>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const MAX_SAVED_BYTES = 4096;
function key(actorId: string, projectId: string): string {
  return `wrenly:database-action:v1:${encodeURIComponent(actorId)}:${projectId}`;
}
/** Corrupt or inaccessible storage blocks commands rather than silently forgetting a possible admission. */
export function readPendingDatabaseAction(storage: Storage, actorId: string, projectId: string): PendingDatabaseAction | null {
  const saved = storage.getItem(key(actorId, projectId));
  if (saved === null) return null;
  if (new TextEncoder().encode(saved).byteLength > MAX_SAVED_BYTES) throw new Error("Pending action is oversized");
  const result = PendingAction.parse(JSON.parse(saved) as unknown);
  if (result.actorId !== actorId || result.projectId !== projectId) throw new Error("Pending action identity changed");
  return result;
}
/** Must succeed before the first POST; restored entries always count as potentially sent. */
export function savePendingDatabaseAction(storage: Storage, value: PendingDatabaseAction): void {
  const pending = PendingAction.parse(value);
  storage.setItem(key(pending.actorId, pending.projectId), JSON.stringify(pending));
}
/** Never clear another request's recovery identity when a late response arrives. */
export function clearPendingDatabaseAction(storage: Storage, value: PendingDatabaseAction): void {
  const saved = readPendingDatabaseAction(storage, value.actorId, value.projectId);
  if (saved && JSON.stringify(saved) !== JSON.stringify(PendingAction.parse(value))) throw new Error("Another action is pending");
  storage.removeItem(key(value.actorId, value.projectId));
}
