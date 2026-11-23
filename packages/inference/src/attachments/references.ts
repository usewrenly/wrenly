/** Saved request references identify immutable private objects; they never contain provider URLs. */
import { ATTACHMENT_LIMITS, AttachmentPolicyError } from "./policy";
export interface AttachmentReference {
  id: string;
  objectId: string;
  name: string;
  mediaType: "image/webp" | "text/plain" | "text/markdown";
  byteLength: number;
  sha256: string;
}
export interface AttachmentSnapshot {
  version: 1;
  files: AttachmentReference[];
}
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FIELDS = ["id", "objectId", "name", "mediaType", "byteLength", "sha256"];
/** Revalidates saved/MCP references independently of the upload request. Historical requests have no attachments. */
export function parseAttachmentSnapshot(value: unknown): AttachmentSnapshot {
  if (value === undefined) return { version: 1, files: [] };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AttachmentPolicyError("Invalid saved attachment references.");
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1 ||
    Object.keys(snapshot).some((key) => !["version", "files"].includes(key)) ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length > ATTACHMENT_LIMITS.count
  )
    throw new AttachmentPolicyError("Invalid saved attachment references.");
  const ids = new Set<string>();
  const files: AttachmentReference[] = [];
  let total = 0;
  for (const raw of snapshot.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AttachmentPolicyError("Invalid saved attachment reference.");
    const file = raw as Record<string, unknown>;
    if (
      Object.keys(file).length !== FIELDS.length ||
      Object.keys(file).some((key) => !FIELDS.includes(key)) ||
      typeof file.id !== "string" ||
      !ID.test(file.id) ||
      ids.has(file.id) ||
      typeof file.objectId !== "string" ||
      !ID.test(file.objectId) ||
      typeof file.name !== "string" ||
      !file.name.trim() ||
      file.name.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(file.name) ||
      !["image/webp", "text/plain", "text/markdown"].includes(
        String(file.mediaType),
      ) ||
      typeof file.byteLength !== "number" ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength <= 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new AttachmentPolicyError("Invalid saved attachment reference.");
    const image = file.mediaType === "image/webp";
    if (
      file.byteLength >
      (image ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.textBytes)
    )
      throw new AttachmentPolicyError("Saved attachment exceeds its budget.");
    total += file.byteLength;
    if (total > ATTACHMENT_LIMITS.uploadBytes)
      throw new AttachmentPolicyError(
        "Saved attachments exceed their combined budget.",
      );
    ids.add(file.id);
    files.push({
      id: file.id,
      objectId: file.objectId,
      name: file.name,
      mediaType: file.mediaType as AttachmentReference["mediaType"],
      byteLength: file.byteLength,
      sha256: file.sha256,
    });
  }
  return { version: 1, files };
}
