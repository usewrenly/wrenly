/** Browser-safe attachment metadata never includes instance filesystem identities. */
export interface PromptAttachment {
  id: string;
  name: string;
  mediaType: "image/webp" | "text/plain" | "text/markdown";
  byteLength: number;
  sha256: string;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function parsePromptAttachment(value: unknown): PromptAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Attachment metadata could not be read.");
  const file = value as Record<string, unknown>;
  if (
    typeof file.id !== "string" ||
    !UUID.test(file.id) ||
    typeof file.name !== "string" ||
    !file.name ||
    file.name.length > 160 ||
    !["image/webp", "text/plain", "text/markdown"].includes(
      String(file.mediaType),
    ) ||
    typeof file.byteLength !== "number" ||
    !Number.isSafeInteger(file.byteLength) ||
    file.byteLength <= 0 ||
    file.byteLength > 5 * 1024 * 1024 ||
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new Error("Attachment metadata could not be read.");
  return {
    id: file.id,
    name: file.name,
    mediaType: file.mediaType as PromptAttachment["mediaType"],
    byteLength: file.byteLength,
    sha256: file.sha256,
  };
}
export function parseAttachmentIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new Error("The saved reference selection is invalid.");
  return [...value] as string[];
}
