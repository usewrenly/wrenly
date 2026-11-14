/** Connects private reference files to model admission and execution without starting a worker on import. */
import { join } from "node:path";
import type { db } from "@wrenly/db";
import {
  parseAttachmentSnapshot,
  parseAttachmentWireContent,
  encodeAttachmentWireContent,
  type AttachmentSnapshot,
  type AttachmentWireContent,
} from "@wrenly/inference";
import { assertModelImageInputs } from "../models/selection/saved-providers";
import {
  createAttachmentObjectStore,
  type AttachmentObjectStore,
} from "./storage/object-store";
import { resolveAttachmentContent } from "./resolve-content";
import { AttachmentStoreError } from "./attachment-error";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Storage is opened only on use; callers supply a validated instance data directory. */
export function attachmentObjects(directory: string): AttachmentObjectStore {
  let opening: Promise<AttachmentObjectStore> | undefined;
  const get = (): Promise<AttachmentObjectStore> => {
    if (!opening)
      opening = createAttachmentObjectStore(
        join(directory, "attachments"),
      ).catch((error) => {
        opening = undefined;
        throw error;
      });
    return opening;
  };
  return {
    write: async (bytes, reservedId) => (await get()).write(bytes, reservedId),
    read: async (object) => (await get()).read(object),
    remove: async (id) => (await get()).remove(id),
  };
}
/** Capability checks run at admission and again immediately before a model request. */
export async function validateAttachmentModel(
  database: Pick<typeof db, "select">,
  provider: string,
  model: string,
  snapshot: AttachmentSnapshot,
): Promise<void> {
  if (
    !parseAttachmentSnapshot(snapshot).files.some(
      (file) => file.mediaType === "image/webp",
    )
  )
    return;
  try {
    await assertModelImageInputs(database, provider, model);
  } catch (error) {
    throw new AttachmentStoreError(
      409,
      error instanceof Error
        ? error.message
        : "Review this model’s image support in Settings → Providers.",
    );
  }
}
/** Verifies files and encoded payload budgets before committing work, rather than after starting inference. */
export function attachmentAdmissionValidator(
  directory: string,
): (
  tx: Transaction,
  provider: string,
  model: string,
  snapshot: AttachmentSnapshot,
) => Promise<void> {
  const objects = attachmentObjects(directory);
  return async (tx, provider, model, snapshot) => {
    await validateAttachmentModel(tx, provider, model, snapshot);
    encodeAttachmentWireContent(
      await resolveAttachmentContent(objects, snapshot),
    );
  };
}
/** Returns exactly the saved reference bytes for a currently owned execution claim. */
export async function attachmentExecutionContent(
  directory: string,
  snapshot: AttachmentSnapshot | undefined,
): Promise<AttachmentWireContent> {
  return encodeAttachmentWireContent(
    await resolveAttachmentContent(attachmentObjects(directory), snapshot),
  );
}
/** Checks versioned inline MCP content against the current saved model capability without trusting tool arguments. */
export async function validateAttachmentExecution(
  database: Pick<typeof db, "select">,
  provider: string,
  model: string,
  payload: AttachmentWireContent | undefined,
): Promise<void> {
  if (
    parseAttachmentWireContent(payload).some(
      (file) => file.mediaType === "image/webp",
    )
  )
    await assertModelImageInputs(database, provider, model);
}
