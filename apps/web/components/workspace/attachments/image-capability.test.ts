import { expect, test } from "bun:test";
import {
  isImageAttachment,
  parseSavedConnectionId,
} from "./image-capability-banner";
import type { ComposerAttachment } from "./use-prompt-attachments";

test("parseSavedConnectionId extracts saved provider connection UUIDs and rejects env or malformed IDs", () => {
  const connectionId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  expect(parseSavedConnectionId(`saved:${connectionId}:${versionId}`)).toBe(
    connectionId,
  );
  expect(parseSavedConnectionId("ollama")).toBeNull();
  expect(parseSavedConnectionId("env")).toBeNull();
  expect(parseSavedConnectionId(`saved:${connectionId}`)).toBeNull();
  expect(parseSavedConnectionId("saved:not-a-uuid:also-invalid")).toBeNull();
});

test("isImageAttachment distinguishes uploaded or staged images from text references", () => {
  const imageByMime: ComposerAttachment = {
    localId: "a",
    file: new File(["x"], "screen.png", { type: "image/png" }),
    status: "uploading",
  };
  const imageByExtension: ComposerAttachment = {
    localId: "b",
    file: new File(["x"], "layout.webp", { type: "" }),
    status: "ready",
  };
  const markdownDoc: ComposerAttachment = {
    localId: "c",
    file: new File(["# spec"], "spec.md", { type: "text/markdown" }),
    status: "ready",
  };

  expect(isImageAttachment(imageByMime)).toBe(true);
  expect(isImageAttachment(imageByExtension)).toBe(true);
  expect(isImageAttachment(markdownDoc)).toBe(false);
});
