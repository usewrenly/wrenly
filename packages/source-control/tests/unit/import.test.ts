import { expect, test } from "bun:test";
import {
  readGitHubRepository,
  readGitHubSourceTree,
  validateSourceFiles,
  shouldExcludeSourcePath,
} from "../../src";
const sha = "a".repeat(40);
const blob = (
  path = "app/page.tsx",
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  path,
  sha,
  mode: "100644",
  type: "blob",
  size: 8,
  ...extra,
});
const tree = (entries: unknown[]): unknown => ({
  sha,
  truncated: false,
  tree: entries,
});
const repository = {
  id: 42,
  name: "studio",
  owner: { login: "team" },
  private: true,
  disabled: false,
  archived: false,
};
test("repository replies pin stable identity and omit unrelated provider data", () => {
  const saved = readGitHubRepository({
    ...repository,
    secret: "never returned",
  });
  expect(saved).toEqual({
    provider: "github",
    id: "42",
    owner: "team",
    name: "studio",
    private: true,
  });
  for (const changed of [
    { id: 43 },
    { name: "renamed" },
    { private: false },
    { archived: true },
  ])
    expect(() =>
      readGitHubRepository({ ...repository, ...changed }, saved),
    ).toThrow();
  for (const invalid of [
    null,
    {},
    { ...repository, id: 1.5 },
    { ...repository, owner: { login: "../escape" } },
  ])
    expect(() => readGitHubRepository(invalid)).toThrow();
});
test("complete trees expose only bounded regular source blobs", () => {
  const result = readGitHubSourceTree(
    tree([blob(), blob(".env"), blob(".env.example"), blob("vendor/a.php")]),
    sha,
  );
  expect(result.entries.map((file) => file.path)).toEqual([
    "app/page.tsx",
    ".env.example",
  ]);
  expect(result.excludedPaths).toEqual([".env", "vendor/a.php"]);
  for (const value of [
    { sha, truncated: true, tree: [blob()] },
    { sha: "b".repeat(40), truncated: false, tree: [blob()] },
    tree([]),
  ])
    expect(() => readGitHubSourceTree(value, sha)).toThrow();
});
test("unsafe paths, special Git entries and oversized replies never become source", () => {
  for (const path of [
    "../x",
    "/absolute",
    "a//b",
    "a\\b",
    "a/%2e%2e/b",
    "a\u0000b",
    "e\u0301.ts",
  ])
    expect(() => readGitHubSourceTree(tree([blob(path)]), sha)).toThrow();
  for (const entry of [
    blob("link", { mode: "120000" }),
    blob("submodule", { type: "commit", mode: "160000" }),
    blob("large", { size: 600000 }),
    blob("bad", { size: -1 }),
  ])
    expect(() => readGitHubSourceTree(tree([entry]), sha)).toThrow();
  for (const paths of [
    ["A.ts", "a.ts"],
    ["a", "a/b"],
  ])
    expect(() =>
      readGitHubSourceTree(tree(paths.map((path) => blob(path))), sha),
    ).toThrow();
});
test("decoded content is checked independently of tree metadata", () => {
  expect(
    validateSourceFiles([{ path: "README.md", content: "A studio\n" }]),
  ).toEqual([{ path: "README.md", content: "A studio\n" }]);
  for (const content of [
    "binary\u0000",
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc",
    "\ud800",
    "x".repeat(600000),
  ])
    expect(() =>
      validateSourceFiles([{ path: "file.txt", content }]),
    ).toThrow();
  for (const path of [
    ".env",
    ".env.production",
    ".npmrc",
    "nested/auth.json",
    "key.pem",
  ])
    expect(shouldExcludeSourcePath(path)).toBe(true);
  expect(() =>
    validateSourceFiles([{ path: ".env", content: "SECRET=hidden" }]),
  ).toThrow();
});

test("ordinary spaces and framework route groups survive source review", () => {
  const paths = ["app/(marketing)/page.tsx", "app/blog/[slug]/page.tsx", "docs/Getting started.md", "public/brand assets/logo.svg"];
  const result = readGitHubSourceTree(tree(paths.map(path => blob(path))), sha);
  expect(result.entries.map(file => file.path)).toEqual(paths);
  expect(validateSourceFiles(paths.map(path => ({ path, content: "text source" })))).toHaveLength(paths.length);
  for (const path of ["docs/trailing /page.md", "docs/trailing./page.md", "public/NUL.png", "docs/tab\tname.md"])
    expect(() => readGitHubSourceTree(tree([blob(path)]), sha)).toThrow("unsafe_path");
});
