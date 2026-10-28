/** Independently fenced cleanup can outlive user revocation, but cannot authorize new app work. */
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  appDatabases,
  projects,
  user,
  previews,
  previewDatabaseBindings,
  previewDatabaseRuntime,
  type db,
} from "@wrenly/db";
import { PreviewDatabaseCleanupKind } from "@wrenly/db/app-database-runtime-contract";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { AppDatabaseError } from "../database-contract";
import { lockDatabaseQueues } from "../database-store";
import type { RuntimeKernelFence } from "./runtime-store";
import {
  CLEANUP_LEASE_MS,
  CLEANUP_DEADLINE_MS,
  MAX_RUNTIME_RECEIPTS,
  RUNTIME_CLEANUP_KINDS,
  previewRuntimeCleanupTarget,
} from "./runtime-policy";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface PreviewDatabaseCleanupClaim {
  preview: PreviewClaim;
  token: string;
}
const TERMINAL = ["failed", "stopped", "expired", "interrupted"];

/** Closing sessions is meaningful only after the application and socket can no longer reconnect. */
function assertCleanupOrder(
  claim: PreviewDatabaseCleanupClaim,
  kind: PreviewDatabaseCleanupKind,
  receipts: readonly { kind: PreviewDatabaseCleanupKind; id: string }[],
): void {
  const position = RUNTIME_CLEANUP_KINDS.indexOf(kind);
  const prerequisites = RUNTIME_CLEANUP_KINDS.slice(0, position);
  if (
    receipts.some((receipt) => receipt.kind === kind) ||
    !prerequisites.every((required) =>
      receipts.some(
        (receipt) =>
          receipt.kind === required &&
          receipt.id === previewRuntimeCleanupTarget(claim.preview, required),
      ),
    )
  )
    throw new Error("Earlier cleanup must be confirmed against its original target");
}

async function lockStoppedPreview(
  tx: Transaction,
  claim: PreviewClaim,
  assertKernel: RuntimeKernelFence,
) {
  await assertKernel();
  await lockDatabaseQueues(tx, { wait: true });
  const [snapshot] = await tx
    .select({
      actorId: previews.userId,
      resourceId: previewDatabaseBindings.resourceId,
    })
    .from(previews)
    .innerJoin(
      previewDatabaseBindings,
      eq(previewDatabaseBindings.previewId, previews.id),
    )
    .where(
      and(
        eq(previews.id, claim.previewId),
        eq(previews.projectId, claim.projectId),
        eq(previews.buildId, claim.buildId),
        eq(previews.claimToken, claim.token),
      ),
    );
  if (!snapshot) throw new Error("Original preview changed");
  // Cleanup locks identities without requiring the revoked account to become active again.
  await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, snapshot.actorId))
    .for("update");
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, claim.projectId))
    .for("update");
  await tx
    .select({ id: appDatabases.id })
    .from(appDatabases)
    .where(eq(appDatabases.id, snapshot.resourceId))
    .for("update");
  const [preview] = await tx
    .select()
    .from(previews)
    .where(
      and(
        eq(previews.id, claim.previewId),
        eq(previews.claimToken, claim.token),
        isNull(previews.cleanupCompletedAt),
      ),
    )
    .for("update");
  const [runtime] = await tx
    .select()
    .from(previewDatabaseRuntime)
    .where(eq(previewDatabaseRuntime.previewId, claim.previewId))
    .for("update");
  if (!preview || !TERMINAL.includes(preview.status) || !runtime)
    throw new Error("Revoke preview before cleanup");
  await assertKernel();
  return runtime;
}

function heldCleanup(claim: PreviewDatabaseCleanupClaim) {
  return and(
    eq(previewDatabaseRuntime.previewId, claim.preview.previewId),
    eq(previewDatabaseRuntime.cleanupToken, claim.token),
    gt(previewDatabaseRuntime.cleanupLeaseExpiresAt, new Date()),
    gt(previewDatabaseRuntime.cleanupDeadlineAt, new Date()),
  );
}

/** Exact live replay returns the same cleanup authority; an expired token is never revived. */
export async function beginPreviewDatabaseCleanup(
  database: typeof db,
  preview: PreviewClaim,
  token: string,
  assertKernel: RuntimeKernelFence,
): Promise<PreviewDatabaseCleanupClaim> {
  try {
    z.string().uuid().parse(token);
    await database.transaction(async (tx) => {
      const row = await lockStoppedPreview(tx, preview, assertKernel);
      const now = Date.now();
      if (row.cleanupToken === token) {
        if (
          !row.cleanupLeaseExpiresAt ||
          row.cleanupLeaseExpiresAt.getTime() <= now ||
          !row.cleanupDeadlineAt ||
          row.cleanupDeadlineAt.getTime() <= now
        )
          throw new Error("Expired cleanup cannot replay");
        return;
      }
      if (
        row.cleanupToken &&
        row.cleanupLeaseExpiresAt &&
        row.cleanupLeaseExpiresAt.getTime() > now &&
        row.cleanupDeadlineAt &&
        row.cleanupDeadlineAt.getTime() > now
      )
        throw new Error("Another cleanup owner is active");
      await tx
        .update(previewDatabaseRuntime)
        .set({
          cleanupToken: token,
          cleanupLeaseExpiresAt: new Date(now + CLEANUP_LEASE_MS),
          cleanupDeadlineAt: new Date(now + CLEANUP_DEADLINE_MS),
        })
        .where(eq(previewDatabaseRuntime.previewId, preview.previewId));
    });
    await assertKernel();
    return { preview, token };
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database cleanup ownership could not be confirmed. Preserve its reservation.",
    );
  }
}

/** Every cleanup mutation checks this separate claim plus the original preview kernel lock. */
export async function assertPreviewDatabaseCleanup(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    await assertKernel();
    const [row] = await database
      .select({ status: previews.status })
      .from(previewDatabaseRuntime)
      .innerJoin(previews, eq(previews.id, previewDatabaseRuntime.previewId))
      .where(
        and(
          heldCleanup(claim),
          eq(previews.claimToken, claim.preview.token),
          eq(previews.projectId, claim.preview.projectId),
          eq(previews.buildId, claim.preview.buildId),
          isNull(previews.cleanupCompletedAt),
        ),
      )
      .limit(1);
    if (!row || !TERMINAL.includes(row.status))
      throw new Error("Cleanup lease expired");
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database cleanup lease is no longer held.",
    );
  }
}

/** Resume only an exact ordered prefix; arbitrary receipts cannot cause a removal to be skipped. */
export async function nextPreviewDatabaseCleanup(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
): Promise<PreviewDatabaseCleanupKind | null> {
  try {
    await assertPreviewDatabaseCleanup(database, claim, assertKernel);
    const next = await database.transaction(async (tx) => {
      const row = await lockStoppedPreview(tx, claim.preview, assertKernel);
      if (row.cleanupToken !== claim.token) throw new Error("Cleanup owner changed");
      const completed = row.completedCleanupEffects;
      if (
        completed.length > RUNTIME_CLEANUP_KINDS.length ||
        completed.some((receipt, index) => {
          const kind = RUNTIME_CLEANUP_KINDS[index];
          return !kind || receipt.kind !== kind ||
            receipt.id !== previewRuntimeCleanupTarget(claim.preview, kind);
        })
      ) throw new Error("Cleanup receipts are not an exact ordered prefix");
      const kind = RUNTIME_CLEANUP_KINDS[completed.length] ?? null;
      if (
        row.cleanupEffect && (!kind || row.cleanupEffect.kind !== kind ||
          row.cleanupEffect.id !== previewRuntimeCleanupTarget(claim.preview, kind))
      )
        throw new Error("Pending cleanup target changed");
      return kind;
    });
    await assertPreviewDatabaseCleanup(database, claim, assertKernel);
    return next;
  } catch {
    throw new AppDatabaseError(409,
      "Preview cleanup progress could not be verified. Preserve its reservation and saved targets.");
  }
}

/** Renewal is bounded by the original cleanup deadline, even after application cancellation. */
export async function renewPreviewDatabaseCleanup(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    await assertPreviewDatabaseCleanup(database, claim, assertKernel);
    const [row] = await database
      .select({ deadline: previewDatabaseRuntime.cleanupDeadlineAt })
      .from(previewDatabaseRuntime)
      .where(heldCleanup(claim));
    if (!row?.deadline) throw new Error("Cleanup missing");
    const updated = await database
      .update(previewDatabaseRuntime)
      .set({
        cleanupLeaseExpiresAt: new Date(
          Math.min(Date.now() + CLEANUP_LEASE_MS, row.deadline.getTime()),
        ),
      })
      .where(heldCleanup(claim))
      .returning({ id: previewDatabaseRuntime.previewId });
    if (updated.length !== 1) throw new Error("Cleanup renewal lost");
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database cleanup was not renewed. Preserve the reservation for recovery.",
    );
  }
}

/** Record only fixed cleanup targets. A pending acknowledgement cannot be overwritten by another category. */
export async function recordPreviewDatabaseCleanup(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  kind: PreviewDatabaseCleanupKind,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    PreviewDatabaseCleanupKind.parse(kind);
    await database.transaction(async (tx) => {
      const row = await lockStoppedPreview(tx, claim.preview, assertKernel);
      if (
        row.cleanupToken !== claim.token ||
        !row.cleanupLeaseExpiresAt ||
        row.cleanupLeaseExpiresAt.getTime() <= Date.now() ||
        !row.cleanupDeadlineAt ||
        row.cleanupDeadlineAt.getTime() <= Date.now() ||
        row.completedCleanupEffects.length >= MAX_RUNTIME_RECEIPTS
      )
        throw new Error("Cleanup lease expired");
      assertCleanupOrder(claim, kind, row.completedCleanupEffects);
      const id = previewRuntimeCleanupTarget(claim.preview, kind);
      if (row.cleanupEffect) {
        if (row.cleanupEffect.kind === kind && row.cleanupEffect.id === id)
          return;
        throw new Error("Another cleanup effect is unresolved");
      }
      const changed = await tx
        .update(previewDatabaseRuntime)
        .set({
          cleanupEffect: { kind, id, startedAt: new Date().toISOString() },
        })
        .where(heldCleanup(claim))
        .returning({ id: previewDatabaseRuntime.previewId });
      if (changed.length !== 1) throw new Error("Cleanup intent lost");
    });
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database cleanup intent is uncertain. Inspect its saved target before continuing.",
    );
  }
}

/** Cleanup acknowledgement never acknowledges or erases the original execution effect. */
export async function acknowledgePreviewDatabaseCleanup(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  kind: PreviewDatabaseCleanupKind,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    PreviewDatabaseCleanupKind.parse(kind);
    await database.transaction(async (tx) => {
      const row = await lockStoppedPreview(tx, claim.preview, assertKernel);
      if (
        row.cleanupToken !== claim.token ||
        row.cleanupEffect?.kind !== kind ||
        row.cleanupEffect.id !==
          previewRuntimeCleanupTarget(claim.preview, kind) ||
        row.completedCleanupEffects.length >= MAX_RUNTIME_RECEIPTS
      )
        throw new Error("Cleanup acknowledgement changed");
      // Recheck persisted prerequisites at acknowledgement, not merely before removal starts.
      assertCleanupOrder(claim, kind, row.completedCleanupEffects);
      const changed = await tx
        .update(previewDatabaseRuntime)
        .set({
          cleanupEffect: null,
          completedCleanupEffects: [
            ...row.completedCleanupEffects,
            row.cleanupEffect,
          ],
        })
        .where(heldCleanup(claim))
        .returning({ id: previewDatabaseRuntime.previewId });
      if (changed.length !== 1) throw new Error("Cleanup lease expired");
    });
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database cleanup acknowledgement could not be confirmed.",
    );
  }
}

/** Release capacity only after all scoped removals/session termination are confirmed; retain unknown execution history. */
export async function finishPreviewDatabaseCleanup(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      const row = await lockStoppedPreview(tx, claim.preview, assertKernel);
      if (
        row.cleanupToken !== claim.token ||
        row.cleanupEffect ||
        !RUNTIME_CLEANUP_KINDS.every((kind) =>
          row.completedCleanupEffects.some(
            (effect) =>
              effect.kind === kind &&
              effect.id === previewRuntimeCleanupTarget(claim.preview, kind),
          ),
        )
      )
        throw new Error("Cleanup remains unresolved");
      const changed = await tx
        .update(previewDatabaseRuntime)
        .set({ cleanupToken: null, cleanupLeaseExpiresAt: null })
        .where(heldCleanup(claim))
        .returning({ id: previewDatabaseRuntime.previewId });
      if (changed.length !== 1) throw new Error("Cleanup lease expired");
      await assertKernel();
      const released = await tx
        .update(previews)
        .set({
          cleanupCompletedAt: new Date(),
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(previews.id, claim.preview.previewId),
            eq(previews.claimToken, claim.preview.token),
            isNull(previews.cleanupCompletedAt),
          ),
        )
        .returning({ id: previews.id });
      if (released.length !== 1)
        throw new Error("Preview cleanup completion changed");
    });
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database cleanup is incomplete. Keep its capacity reservation and saved effects.",
    );
  }
}
