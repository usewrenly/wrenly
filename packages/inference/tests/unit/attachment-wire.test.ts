import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  encodeAttachmentWireContent,
  parseAttachmentWireContent,
} from "../../src/attachments/wire-content";
test("MCP attachment encoding round-trips exact content and independently rejects changed bytes", () => {
  const bytes = new TextEncoder().encode("Reference instructions");
  const payload = encodeAttachmentWireContent([
    {
      bytes,
      mediaType: "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ]);
  expect(
    new TextDecoder().decode(parseAttachmentWireContent(payload)[0]!.bytes),
  ).toBe("Reference instructions");
  payload.files[0]!.dataBase64 = Buffer.from("changed").toString("base64");
  expect(() => parseAttachmentWireContent(payload)).toThrow();
});
test("MCP content rejects forgiving base64, unknown versions and remote URLs", () => {
  expect(parseAttachmentWireContent(undefined)).toEqual([]);
  expect(() => parseAttachmentWireContent({ version: 2, files: [] })).toThrow();
  expect(() =>
    parseAttachmentWireContent({
      version: 1,
      files: [
        {
          mediaType: "text/plain",
          sha256: "a".repeat(64),
          dataBase64: "YQ==\n",
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    parseAttachmentWireContent({
      version: 1,
      files: [],
      url: "https://example.com",
    }),
  ).toThrow();
});
