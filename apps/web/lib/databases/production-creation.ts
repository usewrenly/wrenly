/** Bounded Production creation requests and actor/project-scoped lost-response identity. */
import { z } from "zod";
import {
  ProductionProjectCreationInput,
  ProductionProjectCreationReceipt,
  ProductionProjectCreationState,
} from "@wrenly/db/production-project-contract";
import { apiFetch } from "../api";
const MAX_BYTES = 8192,
  TIMEOUT_MS = 15000;
const REJECTED = new Set([400, 401, 403, 404, 409, 413, 415, 429]);
type Transport = (
  path: `/api/${string}`,
  options: RequestInit,
) => Promise<Response>;
export type ProductionCreationState = z.infer<
  typeof ProductionProjectCreationState
>;
export const PendingProductionCreation = z
  .object({
    version: z.literal(1),
    actorId: z.string().min(1).max(200),
    projectId: z.uuid(),
    input: ProductionProjectCreationInput,
  })
  .strict();
export type PendingProductionCreation = z.infer<
  typeof PendingProductionCreation
>;
export class ProductionCreationError extends Error {
  constructor(readonly reason: "rejected" | "unknown" | "unavailable") {
    super(
      reason === "rejected"
        ? "The request was not accepted. Reload the current project and setup before reviewing again."
        : reason === "unavailable"
          ? "Production database creation is not enabled on this instance."
          : "This request could not be confirmed. Check its saved status before trying again.",
    );
  }
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Oversized creation response");
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(joined),
    ) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** A missing exact request is not proof that a previous in-flight submission cannot commit. */
export async function readProductionCreation(
  projectId: string,
  signal: AbortSignal,
  requestId?: string,
  transport: Transport = apiFetch,
): Promise<ProductionCreationState | null> {
  try {
    z.uuid().parse(projectId);
    if (requestId) z.uuid().parse(requestId);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const response = await transport(
      `/api/projects/${projectId}/databases/production/creation${requestId ? `/requests/${requestId}` : ""}`,
      { cache: "no-store", signal: deadline },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) {
        if (requestId) return null;
        throw new ProductionCreationError("unavailable");
      }
      throw new ProductionCreationError("unknown");
    }
    const result = ProductionProjectCreationState.parse(
      await body(response, deadline),
    );
    if (
      result.projectId !== projectId ||
      (requestId && result.creation?.requestId !== requestId)
    )
      throw new Error("Foreign creation request");
    return result;
  } catch (error) {
    if (error instanceof ProductionCreationError) throw error;
    throw new ProductionCreationError("unknown");
  }
}
/** Caller must save the exact request locally before invoking this POST; identical retries keep the original UUID. */
export async function submitProductionCreation(
  pending: PendingProductionCreation,
  signal: AbortSignal,
  transport: Transport = apiFetch,
): Promise<z.infer<typeof ProductionProjectCreationReceipt>> {
  try {
    const saved = PendingProductionCreation.parse(pending),
      deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const response = await transport(
      `/api/projects/${saved.projectId}/databases/production/creation`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(saved.input),
        cache: "no-store",
        signal: deadline,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductionCreationError(
        REJECTED.has(response.status) ? "rejected" : "unknown",
      );
    }
    return ProductionProjectCreationReceipt.parse(
      await body(response, deadline),
    );
  } catch (error) {
    if (error instanceof ProductionCreationError) throw error;
    throw new ProductionCreationError("unknown");
  }
}
function key(actorId: string, projectId: string): string {
  return `wrenly:production-creation:${JSON.stringify([actorId, projectId])}`;
}
/** No private connection details or credentials are stored here. A malformed entry blocks a new write. */
export function readPendingProductionCreation(
  storage: Storage,
  actorId: string,
  projectId: string,
): PendingProductionCreation | null {
  const raw = storage.getItem(key(actorId, projectId));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES)
    throw new Error("Saved creation identity is too large.");
  const saved = PendingProductionCreation.parse(JSON.parse(raw) as unknown);
  if (saved.actorId !== actorId || saved.projectId !== projectId)
    throw new Error("Saved creation identity changed.");
  return saved;
}
export function savePendingProductionCreation(
  storage: Storage,
  value: PendingProductionCreation,
): void {
  const saved = PendingProductionCreation.parse(value),
    old = readPendingProductionCreation(
      storage,
      saved.actorId,
      saved.projectId,
    );
  if (old && JSON.stringify(old) !== JSON.stringify(saved))
    throw new Error("Another Production creation is pending.");
  storage.setItem(key(saved.actorId, saved.projectId), JSON.stringify(saved));
}
/** Late responses cannot clear another request's recovery identity. */
export function clearPendingProductionCreation(
  storage: Storage,
  value: PendingProductionCreation,
): void {
  const saved = PendingProductionCreation.parse(value),
    old = readPendingProductionCreation(
      storage,
      saved.actorId,
      saved.projectId,
    );
  if (old && JSON.stringify(old) !== JSON.stringify(saved))
    throw new Error("Another Production creation is pending.");
  storage.removeItem(key(saved.actorId, saved.projectId));
}
