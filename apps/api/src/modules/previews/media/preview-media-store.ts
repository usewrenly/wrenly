// Saves reviewed media origins with project revision checks and audited request replay.
// Changing policy revokes prior preview grants without granting source or runtime network access.
import { AccessDeniedError } from "../../auth/access/access-policy";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  projects,
  previews,
  previewAccess,
  projectAccessActions,
} from "@wrenly/db";
import {
  requireProjectCapability,
  ProjectAccessError,
} from "../../projects/access/project-access";
import { lockDatabaseQueues } from "../../databases/database-store";
import {
  MediaOrigins,
  PREVIEW_MEDIA_ORIGINS,
  PreviewMediaInput,
  PreviewMediaError,
} from "./preview-media-contract";
export interface PreviewMediaPolicy {
  revision: string;
  origins: string[];
  availableOrigins: readonly string[];
  canManage: boolean;
  savedRevision?: string;
  replayed?: boolean;
}
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function read(
  tx: Transaction,
  projectId: string,
  actorId: string,
): Promise<PreviewMediaPolicy> {
  const access = await requireProjectCapability(tx, projectId, actorId, "read");
  const [project] = await tx
    .select({
      revision: projects.accessRevision,
      origins: projects.previewMediaOrigins,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new ProjectAccessError(404, "Project not found.");
  return {
    revision: project.revision,
    origins: MediaOrigins.parse(project.origins),
    availableOrigins: PREVIEW_MEDIA_ORIGINS,
    canManage: access.manage,
  };
}
/** Uses a project lock so permission metadata cannot straddle an access-policy change. */
export async function readPreviewMediaPolicy(
  database: typeof db,
  projectId: string,
  actorId: string,
): Promise<PreviewMediaPolicy> {
  try {
    return await database.transaction((tx) => read(tx, projectId, actorId));
  } catch (error) {
    if (
      error instanceof ProjectAccessError ||
      error instanceof AccessDeniedError
    )
      throw error;
    throw new PreviewMediaError(
      503,
      "Preview media settings could not be loaded.",
    );
  }
}
/** Owner-only exact replay/CAS; every change rotates access revision and revokes preview grants atomically. */
export async function savePreviewMediaPolicy(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<PreviewMediaPolicy> {
  const parsed = PreviewMediaInput.safeParse(body);
  if (!parsed.success)
    throw new PreviewMediaError(
      400,
      "Choose reviewed media hosts and the current settings revision.",
    );
  const input = parsed.data;
  const origins = [...input.origins].sort();
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        "preview-media",
        projectId,
        input.expectedRevision,
        origins,
      ]),
    )
    .digest("hex");
  try {
    return await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      const current = await read(tx, projectId, actorId);
      const [prior] = await tx
        .select()
        .from(projectAccessActions)
        .where(
          and(
            eq(projectAccessActions.projectId, projectId),
            eq(projectAccessActions.actorId, actorId),
            eq(projectAccessActions.requestId, input.requestId),
          ),
        );
      if (prior) {
        if (prior.requestIdentity !== identity)
          throw new PreviewMediaError(
            409,
            "This request belongs to a different settings change.",
          );
        return { ...current, savedRevision: prior.revision, replayed: true };
      }
      if (current.revision !== input.expectedRevision)
        throw new PreviewMediaError(
          409,
          "Project settings changed. Reload before reviewing this change again.",
        );
      const revision = crypto.randomUUID();
      await tx
        .update(projects)
        .set({ previewMediaOrigins: origins, accessRevision: revision })
        .where(eq(projects.id, projectId));
      await tx
        .delete(previewAccess)
        .where(
          inArray(
            previewAccess.previewId,
            tx
              .select({ id: previews.id })
              .from(previews)
              .where(eq(previews.projectId, projectId)),
          ),
        );
      await tx.insert(projectAccessActions).values({
        projectId,
        actorId,
        requestId: input.requestId,
        requestIdentity: identity,
        previousRevision: current.revision,
        revision,
      });
      return {
        ...current,
        revision,
        origins,
        savedRevision: revision,
        replayed: false,
      };
    });
  } catch (error) {
    if (
      error instanceof ProjectAccessError ||
      error instanceof AccessDeniedError ||
      error instanceof PreviewMediaError
    )
      throw error;
    throw new PreviewMediaError(
      503,
      "This save could not be confirmed. Retry only the same request to check its outcome.",
    );
  }
}
/** Gateway resolves policy from an authorized preview, never from generated URLs or headers. */
export async function readAuthorizedPreviewMedia(
  database: typeof db,
  id: string,
  actorId: string,
): Promise<string[]> {
  const [preview] = await database
    .select({ projectId: previews.projectId })
    .from(previews)
    .where(eq(previews.id, id));
  if (!preview) throw new PreviewMediaError(404, "Preview unavailable.");
  return (await readPreviewMediaPolicy(database, preview.projectId, actorId))
    .origins;
}
