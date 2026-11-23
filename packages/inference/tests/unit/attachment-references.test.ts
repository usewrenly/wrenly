import { expect, test } from "bun:test";
import { parseAttachmentSnapshot } from "../../src/attachments/references";
const file = () => ({
  id: crypto.randomUUID(),
  objectId: crypto.randomUUID(),
  name: "Reference.png",
  mediaType: "image/webp",
  byteLength: 100,
  sha256: "a".repeat(64),
});
test("historical requests have no attachments and new references are independently copied", () => {
  expect(parseAttachmentSnapshot(undefined)).toEqual({ version: 1, files: [] });
  const original = file();
  const result = parseAttachmentSnapshot({ version: 1, files: [original] });
  original.name = "changed";
  expect(result.files[0]?.name).toBe("Reference.png");
});
test("rejects duplicate, unsupported, oversized and arbitrary URL references", () => {
  const original = file();
  for (const files of [
    [original, original],
    [{ ...original, objectId: "../../secret" }],
    [{ ...original, mediaType: "image/svg+xml" }],
    [{ ...original, sha256: "invalid" }],
    [{ ...original, name: "a\nb" }],
    [{ ...original, byteLength: 6 * 1024 * 1024 }],
    [{ ...original, url: "https://unreviewed.example" }],
    Array.from({ length: 3 }, () => ({
      ...file(),
      byteLength: 5 * 1024 * 1024,
    })),
  ])
    expect(() => parseAttachmentSnapshot({ version: 1, files })).toThrow();
});
