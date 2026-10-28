/** Fixed operation targets keep cleanup scoped to one preview and its original worker claim. */
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import type {
  PreviewDatabaseEffectKind,
  PreviewDatabaseCleanupKind,
} from "@wrenly/db/app-database-runtime-contract";
export const RUNTIME_EFFECT_ORDER = [
  "prepare-artifact",
  "create-socket",
  "start-application",
] as const;
export const RUNTIME_CLEANUP_KINDS = [
  "application",
  "socket",
  "sessions",
  "artifact",
] as const;
export const MAX_RUNTIME_RECEIPTS = 32;
export const CLEANUP_LEASE_MS = 30_000;
export const CLEANUP_DEADLINE_MS = 60_000;

/** Logical targets identify the entire scoped effect, including resources whose Docker response was lost. */
export function previewRuntimeEffectTarget(
  claim: PreviewClaim,
  kind: PreviewDatabaseEffectKind,
): string {
  return kind === "prepare-artifact"
    ? `wrenly-artifact-${claim.previewId}`
    : kind === "create-socket"
      ? `wrenly-database-socket-${claim.previewId}`
      : `wrenly-preview-${claim.previewId}-${claim.token}`;
}
/** Cleanup has its own targets and receipts, independent of an uncertain execution acknowledgement. */
export function previewRuntimeCleanupTarget(
  claim: PreviewClaim,
  kind: PreviewDatabaseCleanupKind,
): string {
  return kind === "artifact"
    ? previewRuntimeEffectTarget(claim, "prepare-artifact")
    : kind === "socket"
      ? previewRuntimeEffectTarget(claim, "create-socket")
      : kind === "sessions"
        ? `wrenly-database-administrator-${claim.previewId}`
        : previewRuntimeEffectTarget(claim, "start-application");
}
