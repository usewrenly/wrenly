import { expect, test } from "bun:test";
import { insertTranscriptText, MAX_PROMPT_CHARS } from "./insert-transcript";

test("insertTranscriptText inserts into empty drafts, appends on newline, and respects cursor selections", () => {
  expect(insertTranscriptText("", "  Build a booking app  ")).toEqual({
    text: "Build a booking app",
    caret: 19,
  });

  expect(insertTranscriptText("   ", "   ")).toBeNull();

  expect(insertTranscriptText("First line", "Second line", null)).toEqual({
    text: "First line\nSecond line",
    caret: 22,
  });

  expect(
    insertTranscriptText("Add a page for billing", "pricing", {
      start: 6,
      end: 6,
    }),
  ).toEqual({
    text: "Add a pricing page for billing",
    caret: 13,
  });

  expect(
    insertTranscriptText("Replace old words here", "new", {
      start: 8,
      end: 17,
    }),
  ).toEqual({
    text: "Replace new here",
    caret: 11,
  });

  const nearLimit = "a".repeat(MAX_PROMPT_CHARS - 2);
  expect(insertTranscriptText(nearLimit, "too long")).toBeNull();
});
