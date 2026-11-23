/** Owner-confirmed setup inspection/continuation; storage contains only non-secret request identity. */
import { z } from "zod";
import {
  ProductionProjectRecoveryInput,
  ProductionProjectRecoveryReceipt,
} from "@wrenly/db/production-project-contract";
import { apiFetch } from "../api";
import {
  ProductionCreationError,
  readProductionCreationBody,
  type ProductionCreationState,
} from "./production-creation";
const DEADLINE_MS = 15000,
  MAX_PENDING_BYTES = 8192;
const Pending = z
  .object({
    actorId: z.string().min(1).max(200),
    projectId: z.uuid(),
    resourceId: z.uuid(),
    input: ProductionProjectRecoveryInput,
  })
  .strict();
export type PendingProductionRecovery = z.infer<typeof Pending>;
function key(actorId: string, projectId: string): string {
  return `wrenly:production-recovery:${JSON.stringify([actorId, projectId])}`;
}
export function readPendingProductionRecovery(
  storage: Storage,
  actorId: string,
  projectId: string,
): PendingProductionRecovery | null {
  const raw = storage.getItem(key(actorId, projectId));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_PENDING_BYTES)
    throw new Error("Invalid pending recovery size");
  const saved = Pending.parse(JSON.parse(raw) as unknown);
  if (saved.actorId !== actorId || saved.projectId !== projectId)
    throw new Error("Foreign pending recovery");
  return saved;
}
export function savePendingProductionRecovery(
  storage: Storage,
  input: PendingProductionRecovery,
): void {
  const saved = Pending.parse(input),
    old = readPendingProductionRecovery(
      storage,
      saved.actorId,
      saved.projectId,
    );
  if (old && JSON.stringify(old) !== JSON.stringify(saved))
    throw new Error("Another recovery is pending");
  storage.setItem(key(saved.actorId, saved.projectId), JSON.stringify(saved));
}
export function clearPendingProductionRecovery(
  storage: Storage,
  input: PendingProductionRecovery,
): void {
  // Normalize both identities so object property order cannot block acknowledgement.
  const saved = Pending.parse(input);
  const old = readPendingProductionRecovery(storage, saved.actorId, saved.projectId);
  if (old && JSON.stringify(old) !== JSON.stringify(saved))
    throw new Error("Another recovery is pending");
  storage.removeItem(key(saved.actorId, saved.projectId));
}
/** A current status is only an acknowledgement when its exact request and target match. */
export function productionRecoveryAcknowledged(
  saved: PendingProductionRecovery,
  state: ProductionCreationState,
): boolean {
  if (
    saved.projectId !== state.projectId ||
    saved.resourceId !== state.creation?.resourceId ||
    !state.review
  )
    return false;
  return saved.input.kind === "inspect"
    ? state.review.requestId === saved.input.requestId &&
        state.review.resourceId === saved.input.resourceId
    : state.review.resumedRequestId === saved.input.requestId &&
        state.review.reviewId === saved.input.reviewId;
}
export async function submitProductionRecovery(
  saved: PendingProductionRecovery,
  signal: AbortSignal,
  transport: typeof apiFetch = apiFetch,
): Promise<z.infer<typeof ProductionProjectRecoveryReceipt>> {
  try {
    const pending = Pending.parse(saved),
      deadline = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
    const response = await transport(
      `/api/projects/${pending.projectId}/databases/production/creation/recovery`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending.input),
        cache: "no-store",
        signal: deadline,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionCreationError(
        [400, 401, 403, 404, 409, 413, 415, 429].includes(response.status)
          ? "rejected"
          : "unknown",
      );
    }
    const result = ProductionProjectRecoveryReceipt.parse(
      await readProductionCreationBody(response, deadline),
    );
    if (
      result.kind !== pending.input.kind ||
      result.receipt.resourceId !== pending.resourceId ||
      (result.kind === "inspect" &&
        pending.input.kind === "inspect" &&
        result.receipt.resourceId !== pending.input.resourceId)
    )
      throw new Error("Foreign recovery receipt");
    return result;
  } catch (error) {
    if (error instanceof ProductionCreationError) throw error;
    throw new ProductionCreationError("unknown");
  }
}
