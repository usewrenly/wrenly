import { expect, test } from "bun:test";
import {
  reviewSourceChanges,
  assertNewSourceBranch,
} from "../../src/policy/change-review";
test("review reports exact additions, updates and removals without inventing remote deletions", () => {
  expect(
    reviewSourceChanges(
      [
        { path: "z.ts", content: "old" },
        { path: "keep.ts", content: "same" },
        { path: "remove.ts", content: "old" },
      ],
      [
        { path: "new.ts", content: "new" },
        { path: "keep.ts", content: "same" },
        { path: "z.ts", content: "changed" },
      ],
    ),
  ).toEqual([
    { kind: "add", path: "new.ts", content: "new" },
    { kind: "delete", path: "remove.ts" },
    { kind: "update", path: "z.ts", content: "changed" },
  ]);
});
test("review rejects credential exports and every kind of workflow modification", () => {
  const file = { path: ".github/workflows/ci.yml", content: "original" };
  expect(reviewSourceChanges([file], [file])).toEqual([]);
  for (const [before, after] of [
    [[file], [{ ...file, content: "changed" }]],
    [[file], [{ path: "app.ts", content: "app" }]],
    [[{ path: "app.ts", content: "app" }], [file]],
  ])
    expect(() => reviewSourceChanges(before!, after!)).toThrow("Workflow");
  expect(() =>
    reviewSourceChanges(
      [{ path: "app.ts", content: "app" }],
      [{ path: ".env", content: "secret" }],
    ),
  ).toThrow();
});
test("new-branch selection excludes default branches and ambiguous Git refs", () => {
  expect(() => assertNewSourceBranch("wrenly/booking-update")).not.toThrow();
  for (const branch of [
    "main",
    "refs/heads/main",
    "wrenly/a..b",
    "wrenly/a.lock",
    "wrenly//a",
    "wrenly/a/",
    "wrenly/@{a}",
    "wrenly/",
  ])
    expect(() => assertNewSourceBranch(branch)).toThrow();
});
