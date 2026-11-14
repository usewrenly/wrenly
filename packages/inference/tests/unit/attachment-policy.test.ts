import { describe, expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS, decodeAttachmentText, detectAttachmentImage, validateAttachmentBatch } from '../../src/attachments/policy';

describe('attachment admission budgets', () => {
  test('rejects excessive counts and a batch whose individually allowed images exceed the total', () => {
    expect(() => validateAttachmentBatch([1, 1, 1, 1, 1])).toThrow();
    expect(() => validateAttachmentBatch(Array(3).fill(ATTACHMENT_LIMITS.imageBytes))).toThrow();
    expect(() => validateAttachmentBatch([NaN])).toThrow();
    expect(() => validateAttachmentBatch([-1])).toThrow();
    expect(() => validateAttachmentBatch([1.5])).toThrow();
    expect(() => validateAttachmentBatch([ATTACHMENT_LIMITS.uploadBytes])).not.toThrow();
  });
  test('preserves document content and rejects invalid UTF-8, binary, blank and oversized input', () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(decodeAttachmentText(encode('# Reference\nKeep this spacing.'))).toBe('# Reference\nKeep this spacing.');
    for (const bytes of [new Uint8Array([0xc3, 0x28]), encode('a\0b'), encode(' \n'), new Uint8Array(ATTACHMENT_LIMITS.textBytes + 1)])
      expect(() => decodeAttachmentText(bytes)).toThrow();
  });
  test('does not trust an extension or accept unsupported formats', () => {
    expect(() => detectAttachmentImage(new TextEncoder().encode('<svg/>'))).toThrow();
    expect(() => detectAttachmentImage(new Uint8Array(ATTACHMENT_LIMITS.imageBytes + 1))).toThrow();
    expect(detectAttachmentImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
  });
});
