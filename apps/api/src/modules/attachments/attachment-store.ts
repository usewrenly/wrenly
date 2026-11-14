/** Saves private upload ownership and binds references inside the caller's durable admission transaction. */
import type { db } from "@wrenly/db";
import { promptAttachments, user } from "@wrenly/db/schema";
import { and, eq, isNull, count } from "drizzle-orm";
import { z } from "zod";
import {
  parseAttachmentSnapshot,
  type AttachmentReference,
  type AttachmentSnapshot,
  ATTACHMENT_LIMITS,
} from "@wrenly/inference";
import { assertActiveAccount } from "../auth/access/access-policy";
import { requireProjectCapability } from "../projects/access/project-access";
import type { StoredAttachmentObject } from "./storage/object-store";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const MAX_PENDING_UPLOADS = 32;
const Identifier = z.string().uuid();
const Name = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) =>
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
import { AttachmentStoreError } from "./attachment-error";

function reference(
  row: typeof promptAttachments.$inferSelect,
): AttachmentReference {
  return parseAttachmentSnapshot({
    version: 1,
    files: [
      {
        id: row.id,
        objectId: row.objectId,
        name: row.name,
        mediaType: row.mediaType,
        byteLength: row.byteLength,
        sha256: row.sha256,
      },
    ],
  }).files[0]!;
}
/** A unique actor/request pair makes an uncertain upload save safely discoverable. */
export async function saveAttachmentUpload(
  database: typeof db,
  actorId: string,
  input: {
    requestId: string;
    name: string;
    mediaType: AttachmentReference["mediaType"];
    object: StoredAttachmentObject;
  },
): Promise<{ file: AttachmentReference; replayed: boolean }> {
  if (
    !Identifier.safeParse(input.requestId).success ||
    !Name.safeParse(input.name).success
  )
    throw new AttachmentStoreError(
      400,
      "Provide a valid upload identity and filename.",
    );
  parseAttachmentSnapshot({
    version: 1,
    files: [
      {
        ...input.object,
        objectId: input.object.id,
        id: input.requestId,
        name: input.name,
        mediaType: input.mediaType,
      },
    ],
  });
  return database.transaction(async (tx) => {
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, actorId))
      .for("update");
    await assertActiveAccount(tx, actorId);
    const [existing] = await tx
      .select()
      .from(promptAttachments)
      .where(
        and(
          eq(promptAttachments.ownerId, actorId),
          eq(promptAttachments.uploadRequestId, input.requestId),
        ),
      );
    if (existing) {
      if (
        existing.sha256 !== input.object.sha256 ||
        existing.byteLength !== input.object.byteLength ||
        existing.mediaType !== input.mediaType ||
        existing.name !== input.name ||
        existing.removedAt
      )
        throw new AttachmentStoreError(
          409,
          "This upload identity was already used for different content.",
        );
      return { file: reference(existing), replayed: true };
    }
    const [pending] = await tx
      .select({ total: count() })
      .from(promptAttachments)
      .where(
        and(
          eq(promptAttachments.ownerId, actorId),
          isNull(promptAttachments.boundRequestId),
          isNull(promptAttachments.removedAt),
        ),
      );
    if ((pending?.total ?? 0) >= MAX_PENDING_UPLOADS)
      throw new AttachmentStoreError(
        429,
        "Remove unused attachments before uploading more.",
      );
    const [saved] = await tx
      .insert(promptAttachments)
      .values({
        ownerId: actorId,
        uploadRequestId: input.requestId,
        objectId: input.object.id,
        sha256: input.object.sha256,
        byteLength: input.object.byteLength,
        mediaType: input.mediaType,
        name: input.name,
        expiresAt: new Date(Date.now() + ATTACHMENT_LIMITS.abandonedLifetimeMs),
      })
      .returning();
    if (!saved) throw new Error("Attachment save returned no result.");
    return { file: reference(saved), replayed: false };
  });
}

/** Caller already holds the queue/account/project locks and checked contribution permission. */
export async function bindRequestAttachments(
  tx: Transaction,
  actorId: string,
  projectId: string,
  requestId: string,
  ids: readonly string[],
): Promise<AttachmentSnapshot> {
  if (
    ids.length > ATTACHMENT_LIMITS.count ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Identifier.safeParse(id).success)
  )
    throw new AttachmentStoreError(
      400,
      "Choose up to four distinct attachments.",
    );
  const files: AttachmentReference[] = [];
  // Stable row order prevents two admissions from locking the same uploads in opposite orders.
  const rows = new Map<string, typeof promptAttachments.$inferSelect>();
  for (const id of [...ids].sort()) {
    const [row] = await tx
      .select()
      .from(promptAttachments)
      .where(
        and(
          eq(promptAttachments.id, id),
          eq(promptAttachments.ownerId, actorId),
          isNull(promptAttachments.removedAt),
        ),
      )
      .for("update");
    if (
      !row ||
      (row.boundRequestId &&
        (row.boundRequestId !== requestId || row.projectId !== projectId)) ||
      (!row.boundRequestId && row.expiresAt <= new Date())
    )
      throw new AttachmentStoreError(
        409,
        "An attachment is expired, unavailable or already used by another request. Upload it again.",
      );
    rows.set(id, row);
  }
  for (const id of ids) files.push(reference(rows.get(id)!));
  const snapshot = parseAttachmentSnapshot({ version: 1, files });
  for (const id of [...ids].sort())
    await tx
      .update(promptAttachments)
      .set({ projectId, boundRequestId: requestId })
      .where(eq(promptAttachments.id, id));
  return snapshot;
}

/** Reads metadata only after rechecking current personal or project access. */
export async function readAttachmentReference(
  database: typeof db,
  actorId: string,
  id: string,
): Promise<AttachmentReference> {
  if (!Identifier.safeParse(id).success)
    throw new AttachmentStoreError(404, "Attachment not found.");
  return database.transaction(async (tx) => {
    await assertActiveAccount(tx, actorId);
    const [row] = await tx
      .select()
      .from(promptAttachments)
      .where(
        and(eq(promptAttachments.id, id), isNull(promptAttachments.removedAt)),
      );
    if (!row) throw new AttachmentStoreError(404, "Attachment not found.");
    if (row.projectId && row.boundRequestId)
      await requireProjectCapability(tx, row.projectId, actorId, "read");
    else if (row.ownerId !== actorId || row.expiresAt <= new Date())
      throw new AttachmentStoreError(404, "Attachment not found.");
    return reference(row);
  });
}

/** Only abandoned uploads can be removed; saved history retains its exact reference. */
export async function removeAttachmentUpload(
  database: typeof db,
  actorId: string,
  id: string,
): Promise<void> {
  if (!Identifier.safeParse(id).success)
    throw new AttachmentStoreError(404, "Attachment not found.");
  await database.transaction(async (tx) => {
    await assertActiveAccount(tx, actorId);
    const [row] = await tx
      .select()
      .from(promptAttachments)
      .where(
        and(
          eq(promptAttachments.id, id),
          eq(promptAttachments.ownerId, actorId),
        ),
      )
      .for("update");
    if (!row) throw new AttachmentStoreError(404, "Attachment not found.");
    if (row.boundRequestId)
      throw new AttachmentStoreError(
        409,
        "This attachment is retained with saved history.",
      );
    await tx
      .update(promptAttachments)
      .set({ removedAt: new Date() })
      .where(eq(promptAttachments.id, id));
  });
}
