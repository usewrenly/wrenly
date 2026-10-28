/** Remembers what a database preview attempted before Docker, independently of cleanup acknowledgements. */
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  appDatabases,
  previews,
  previewDatabaseRuntime,
  type db,
} from "@wrenly/db";
import {
  PreviewDatabaseEffectKind,
  AppDatabaseSocketIdentity,
} from "@wrenly/db/app-database-runtime-contract";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { requireProjectCapability } from "../../projects/access/project-access";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { lockDatabaseQueues } from "../database-store";
import { AppDatabaseError } from "../database-contract";
import {
  MAX_RUNTIME_RECEIPTS,
  RUNTIME_EFFECT_ORDER,
  previewRuntimeEffectTarget,
} from "./runtime-policy";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RuntimeKernelFence = () => void | Promise<void>;

function heldRuntime(transaction: Transaction, claim: PreviewClaim) {
  return and(
    eq(previewDatabaseRuntime.previewId, claim.previewId),
    isNull(previewDatabaseRuntime.cleanupDeadlineAt),
    inArray(
      previewDatabaseRuntime.previewId,
      transaction
        .select({ id: previews.id })
        .from(previews)
        .where(
          and(
            eq(previews.id, claim.previewId),
            eq(previews.projectId, claim.projectId),
            eq(previews.buildId, claim.buildId),
            eq(previews.claimToken, claim.token),
            gt(previews.leaseExpiresAt, new Date()),
            isNull(previews.cleanupCompletedAt),
            inArray(previews.status, ["preparing", "starting", "ready"]),
          ),
        ),
    ),
  );
}

/** Queue/account/project/resource ordering precedes preview/journal locks; execution never adopts cleanup work. */
async function lockRuntime(
  transaction: Transaction,
  claim: PreviewClaim,
  assertKernel: RuntimeKernelFence,
) {
  await assertKernel();
  await lockDatabaseQueues(transaction, { wait: true });
  const [actor] = await transaction
    .select({ id: previews.userId })
    .from(previews)
    .where(
      and(
        eq(previews.id, claim.previewId),
        eq(previews.projectId, claim.projectId),
        eq(previews.buildId, claim.buildId),
        eq(previews.claimToken, claim.token),
      ),
    );
  if (!actor) throw new Error("Preview claim changed");
  await requireProjectCapability(
    transaction,
    claim.projectId,
    actor.id,
    "contribute",
  );
  const evidence = await assertPreviewDatabaseBinding(transaction, claim);
  await transaction
    .select({ id: appDatabases.id })
    .from(appDatabases)
    .where(eq(appDatabases.id, evidence.binding.resourceId))
    .for("update");
  const [preview] = await transaction
    .select()
    .from(previews)
    .where(
      and(
        eq(previews.id, claim.previewId),
        eq(previews.claimToken, claim.token),
        gt(previews.leaseExpiresAt, new Date()),
        isNull(previews.cleanupCompletedAt),
        inArray(previews.status, ["preparing", "starting", "ready"]),
      ),
    )
    .for("update");
  const [runtime] = await transaction
    .select()
    .from(previewDatabaseRuntime)
    .where(eq(previewDatabaseRuntime.previewId, claim.previewId))
    .for("update");
  if (
    !preview ||
    !runtime ||
    runtime.cleanupDeadlineAt ||
    runtime.completedEffects.length >= MAX_RUNTIME_RECEIPTS
  )
    throw new Error("Runtime ownership changed");
  await assertKernel();
  return { preview, runtime, evidence };
}

/** Save one exact effect before executing it; pending or previously completed phases never restart. */
export async function recordPreviewDatabaseEffect(
  database: typeof db,
  claim: PreviewClaim,
  kind: PreviewDatabaseEffectKind,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    PreviewDatabaseEffectKind.parse(kind);
    await database.transaction(async (tx) => {
      const { preview, runtime } = await lockRuntime(tx, claim, assertKernel);
      if (
        preview.status !== "preparing" ||
        runtime.effect ||
        runtime.cleanupEffect ||
        RUNTIME_EFFECT_ORDER[runtime.completedEffects.length] !== kind
      )
        throw new Error("A runtime effect is already recorded or out of order");
      const changed = await tx
        .update(previewDatabaseRuntime)
        .set({
          effect: {
            kind,
            id: previewRuntimeEffectTarget(claim, kind),
            startedAt: new Date().toISOString(),
          },
        })
        .where(
          and(
            heldRuntime(tx, claim),
            isNull(previewDatabaseRuntime.effect),
            isNull(previewDatabaseRuntime.cleanupEffect),
          ),
        )
        .returning({ id: previewDatabaseRuntime.previewId });
      if (changed.length !== 1) throw new Error("Runtime intent lease expired");
    });
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview runtime intent could not be confirmed. Preserve its saved operation before continuing.",
    );
  }
}

/** Save immutable image/socket identity together with the matching acknowledgement; never replace an earlier identity. */
export async function acknowledgePreviewDatabaseEffect(
  database: typeof db,
  claim: PreviewClaim,
  kind: PreviewDatabaseEffectKind,
  value: unknown,
  assertKernel: RuntimeKernelFence,
): Promise<void> {
  try {
    PreviewDatabaseEffectKind.parse(kind);
    await database.transaction(async (tx) => {
      const { preview, runtime, evidence } = await lockRuntime(
        tx,
        claim,
        assertKernel,
      );
      if (
        !runtime.effect ||
        runtime.effect.kind !== kind ||
        runtime.effect.id !== previewRuntimeEffectTarget(claim, kind) ||
        runtime.cleanupEffect
      )
        throw new Error("Runtime acknowledgement changed");
      const patch: Partial<typeof previewDatabaseRuntime.$inferInsert> = {
        effect: null,
        completedEffects: [...runtime.completedEffects, runtime.effect],
      };
      if (kind === "prepare-artifact") {
        const input = z
          .object({ imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
          .strict()
          .parse(value);
        if (runtime.imageId || preview.status !== "preparing")
          throw new Error("Image already recorded");
        patch.imageId = input.imageId;
      } else if (kind === "create-socket") {
        const socket = AppDatabaseSocketIdentity.parse(value);
        if (
          runtime.socket ||
          !runtime.imageId ||
          socket.id !== claim.previewId ||
          socket.resourceId !== evidence.binding.resourceId ||
          socket.projectId !== claim.projectId ||
          socket.volumeName !== previewRuntimeEffectTarget(claim, kind)
        )
          throw new Error("Socket belongs to a different operation");
        patch.socket = socket;
      } else {
        z.object({}).strict().parse(value);
        if (
          !runtime.imageId ||
          !runtime.socket ||
          preview.status !== "starting" ||
          !preview.resources ||
          preview.resources.preparation?.imageId !== runtime.imageId
        )
          throw new Error("The app has no acknowledged runtime resources");
      }
      await assertKernel();
      const changed = await tx
        .update(previewDatabaseRuntime)
        .set(patch)
        .where(heldRuntime(tx, claim))
        .returning({ id: previewDatabaseRuntime.previewId });
      if (changed.length !== 1)
        throw new Error("Runtime acknowledgement lease expired");
    });
    await assertKernel();
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview runtime acknowledgement is uncertain. Inspect the saved effect instead of repeating it.",
    );
  }
}
