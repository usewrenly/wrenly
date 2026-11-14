/** Resolves saved canonical references without looking up current composer state or fetching remote URLs. */
import {
  parseAttachmentSnapshot,
  type AttachmentSnapshot,
  type ModelAttachment,
} from "@wrenly/inference";
import type { AttachmentObjectStore } from "./storage/object-store";

/** Caller must first hold a currently authorized execution claim or project-read grant. */
export async function resolveAttachmentContent(
  objects: AttachmentObjectStore,
  value: AttachmentSnapshot | undefined,
): Promise<ModelAttachment[]> {
  const snapshot = parseAttachmentSnapshot(value);
  const result: ModelAttachment[] = [];
  for (const file of snapshot.files) {
    const bytes = await objects.read({
      id: file.objectId,
      byteLength: file.byteLength,
      sha256: file.sha256,
    });
    result.push({ bytes, mediaType: file.mediaType, sha256: file.sha256 });
  }
  return result;
}
