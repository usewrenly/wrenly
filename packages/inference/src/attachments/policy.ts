/** Shared limits keep upload admission and model delivery from accepting different budgets. */
export const ATTACHMENT_LIMITS = Object.freeze({
  count: 4,
  imageBytes: 5 * 1024 * 1024,
  uploadBytes: 12 * 1024 * 1024,
  textBytes: 64 * 1024,
  decodedPixels: 16_000_000,
  canonicalImageEdge: 4096,
  modelPayloadBytes: 20 * 1024 * 1024,
  abandonedLifetimeMs: 24 * 60 * 60 * 1000,
});

export type AttachmentMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'text/plain'
  | 'text/markdown';

export class AttachmentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentPolicyError';
  }
}

/** Checks the complete batch, rather than allowing each file to consume the whole budget. */
export function validateAttachmentBatch(byteLengths: readonly number[]): void {
  if (byteLengths.length > ATTACHMENT_LIMITS.count)
    throw new AttachmentPolicyError('Attach up to four files per request.');
  let total = 0;
  for (const bytes of byteLengths) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new AttachmentPolicyError('Attachments must contain valid, nonempty files.');
    total += bytes;
    if (total > ATTACHMENT_LIMITS.uploadBytes)
      throw new AttachmentPolicyError('Attachments together must be at most 12 MiB.');
  }
}

/** Decodes documents strictly: replacement characters must not hide invalid uploaded bytes. */
export function decodeAttachmentText(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_LIMITS.textBytes)
    throw new AttachmentPolicyError('Text attachments must be between 1 byte and 64 KiB.');
  let document: string;
  try {
    document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentPolicyError('Save the document as UTF-8 text before attaching it.');
  }
  if (document.includes('\0') || document.trim().length === 0)
    throw new AttachmentPolicyError('Attach a nonempty text document without binary content.');
  return document;
}

/** Header checks are only preliminary; images still require bounded decoding and sanitizing. */
export function detectAttachmentImage(bytes: Uint8Array): AttachmentMediaType {
  if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_LIMITS.imageBytes)
    throw new AttachmentPolicyError('Each image must be at most 5 MiB.');
  const begins = (signature: readonly number[]): boolean =>
    signature.every((value, index) => bytes[index] === value);
  if (begins([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 12 && begins([0x52, 0x49, 0x46, 0x46]) &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'image/webp';
  throw new AttachmentPolicyError('Attach a JPEG, PNG or WebP image.');
}
