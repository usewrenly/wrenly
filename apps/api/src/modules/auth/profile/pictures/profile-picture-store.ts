/**
 * Canonical profile-picture persistence.
 * Account locks serialize first upload, replacement and removal tombstones.
 * Compare-and-set revisions and exact mutation replay prevent stale overwrite; retrieval requires current account, owner/member or visible project-author authority.
 */
import { readableProjectPredicate } from "../../../projects/access/project-access";
import {
  conversationMessages,
  conversations,
  projects,
  buildJobs,
} from "@wrenly/db";
import { assertActiveAccount } from "../../access/access-policy";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type db,
  profilePictures,
  user,
  member,
  instanceSetup,
} from "@wrenly/db";
import {
  MAX_PICTURE_OUTPUT_BYTES,
  ProfilePictureError,
} from "./profile-picture-policy";
export const PictureMutationSchema = z
  .object({
    mutationId: z.string().uuid(),
    expectedRevision: z.string().uuid().nullable(),
  })
  .strict();
export type PictureMutation = z.infer<typeof PictureMutationSchema>;
export interface PictureMetadata {
  userId: string;
  revision: string | null;
  mutationId: string | null;
  url: string | null;
}
/** Constructs only the authenticated same-instance retrieval route. */
export function profilePictureUrl(userId: string, revision: string): string {
  return `/api/account/profile-picture/image?userId=${encodeURIComponent(userId)}&revision=${revision}`;
}
function metadata(
  userId: string,
  row?: typeof profilePictures.$inferSelect,
): PictureMetadata {
  return {
    userId,
    revision: row?.revision ?? null,
    mutationId: row?.mutationId ?? null,
    url: row?.imageBase64 ? profilePictureUrl(userId, row.revision) : null,
  };
}
/** Returns no bytes; clients use this authoritative metadata to reconcile uncertain writes. */
export async function getProfilePicture(
  database: typeof db,
  actorId: string,
): Promise<PictureMetadata> {
  const [row] = await database
    .select()
    .from(profilePictures)
    .where(eq(profilePictures.userId, actorId));
  return metadata(actorId, row);
}
/** Persists one canonical image or a removal tombstone without overwriting a newer revision. */
export async function saveProfilePicture(
  database: typeof db,
  actorId: string,
  input: PictureMutation,
  bytes: Uint8Array | null,
): Promise<PictureMetadata> {
  if (bytes && (!bytes.length || bytes.length > MAX_PICTURE_OUTPUT_BYTES))
    throw new ProfilePictureError(400, "Invalid processed picture.");
  const contentHash = createHash("sha256")
    .update(bytes ?? "removed")
    .digest("hex");
  return database.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, actorId))
      .for("update");
    if (!account)
      throw new ProfilePictureError(401, "Sign in to update your picture.");
    await assertActiveAccount(tx, actorId);
    const [prior] = await tx
      .select()
      .from(profilePictures)
      .where(eq(profilePictures.userId, actorId));
    if (prior?.mutationId === input.mutationId) {
      if (
        prior.contentHash !== contentHash ||
        prior.expectedRevision !== input.expectedRevision
      )
        throw new ProfilePictureError(
          409,
          "This picture request conflicts with a saved change. Reload your picture.",
        );
      return metadata(actorId, prior);
    }
    if ((prior?.revision ?? null) !== input.expectedRevision)
      throw new ProfilePictureError(
        409,
        "Your picture changed elsewhere. Reload it before saving again.",
      );
    const values = {
      userId: actorId,
      revision: crypto.randomUUID(),
      mutationId: input.mutationId,
      expectedRevision: input.expectedRevision,
      imageBase64: bytes ? Buffer.from(bytes).toString("base64") : null,
      contentHash,
      updatedAt: new Date(),
    };
    await tx
      .insert(profilePictures)
      .values(values)
      .onConflictDoUpdate({ target: profilePictures.userId, set: values });
    return metadata(actorId, values);
  });
}
/** Reads canonical bytes for self, owner/member directory or an author visible through current project access; denied IDs remain indistinguishable. */
export async function readProfilePicture(
  database: typeof db,
  actorId: string,
  targetId: string,
  revision: string,
): Promise<Uint8Array> {
  let [row] =
    actorId === targetId
      ? await database
          .select({ bytes: profilePictures.imageBase64 })
          .from(profilePictures)
          .where(
            and(
              eq(profilePictures.userId, targetId),
              eq(profilePictures.revision, revision),
            ),
          )
      : await database
          .select({ bytes: profilePictures.imageBase64 })
          .from(profilePictures)
          .innerJoin(
            member,
            and(
              eq(member.userId, profilePictures.userId),
              eq(member.userId, targetId),
            ),
          )
          .innerJoin(
            instanceSetup,
            and(
              eq(instanceSetup.organizationId, member.organizationId),
              eq(instanceSetup.id, 1),
              eq(instanceSetup.ownerId, actorId),
            ),
          )
          .where(
            and(
              eq(profilePictures.userId, targetId),
              eq(profilePictures.revision, revision),
            ),
          );
  if (!row?.bytes) {
    const [shared] = await database
      .select({ bytes: profilePictures.imageBase64 })
      .from(profilePictures)
      .innerJoin(
        conversationMessages,
        eq(conversationMessages.actorId, profilePictures.userId),
      )
      .innerJoin(
        conversations,
        eq(conversations.id, conversationMessages.conversationId),
      )
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(
        and(
          eq(profilePictures.userId, targetId),
          eq(profilePictures.revision, revision),
          readableProjectPredicate(database, actorId),
        ),
      )
      .limit(1);
    row = shared;
    if (!row?.bytes) {
      const [buildAuthor] = await database
        .select({ bytes: profilePictures.imageBase64 })
        .from(profilePictures)
        .innerJoin(buildJobs, eq(buildJobs.userId, profilePictures.userId))
        .innerJoin(projects, eq(projects.id, buildJobs.projectId))
        .where(
          and(
            eq(profilePictures.userId, targetId),
            eq(profilePictures.revision, revision),
            readableProjectPredicate(database, actorId),
          ),
        )
        .limit(1);
      row = buildAuthor;
    }
  }
  if (!row?.bytes) throw new ProfilePictureError(404, "Picture unavailable.");
  return Buffer.from(row.bytes, "base64");
}

/** Fails startup clearly when the approved picture migration has not been applied. */
export async function verifyProfilePictureSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select().from(profilePictures).limit(0);
  } catch (error) {
    throw new Error(
      "Profile pictures require migration 0018. Run bun run db:migrate from packages/db.",
      { cause: error },
    );
  }
}
