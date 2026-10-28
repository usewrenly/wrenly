import { expect, test } from "bun:test";
import { validateDeploymentSource } from "../../policy/source-policy";

test("snapshot digest is stable across file order and changes with source", () => {
  const files = [
    { path: "b.ts", content: "b" },
    { path: "a.ts", content: "a" },
  ];
  const snapshot = validateDeploymentSource(files);
  expect(snapshot.sha256).toBe(
    validateDeploymentSource([...files].reverse()).sha256,
  );
  expect(snapshot.sha256).not.toBe(
    validateDeploymentSource([{ path: "a.ts", content: "changed" }]).sha256,
  );
  expect(files[0]?.path).toBe("b.ts");
  expect(snapshot.files[0]?.path).toBe("a.ts");
});

test("rejects private configuration, Git metadata and embedded private keys", () => {
  for (const path of [
    ".env",
    ".env.local",
    "nested/.ENV.production",
    ".git/config",
    ".gitmodules",
    ".npmrc",
    "nested/key.pem",
    ".ssh/config",
  ])
    expect(() =>
      validateDeploymentSource([{ path, content: "secret" }]),
    ).toThrow("private");
  expect(() =>
    validateDeploymentSource([
      { path: "src/config.ts", content: "-----BEGIN OPENSSH PRIVATE KEY-----" },
    ]),
  ).toThrow("private");
  expect(
    validateDeploymentSource([{ path: ".env.example", content: "EXAMPLE=" }])
      .files,
  ).toHaveLength(1);
});
test("permits only the generated credential-free npm compatibility setting", () => {
  expect(
    validateDeploymentSource([
      { path: ".npmrc", content: "legacy-peer-deps=true\n" },
    ]).files,
  ).toHaveLength(1);
  expect(() =>
    validateDeploymentSource([
      { path: ".npmrc", content: "//registry.example/:_authToken=private" },
    ]),
  ).toThrow("private");
});

test("rejects traversal, duplicates, path collisions and case ambiguity", () => {
  for (const path of [
    "../outside",
    "/absolute",
    "a\\b",
    "C:secret",
    "a//b",
    "a/./b",
  ])
    expect(() => validateDeploymentSource([{ path, content: "" }])).toThrow(
      "unsafe",
    );
  for (const paths of [
    ["a", "a"],
    ["a", "a/b"],
    ["a", "A"],
    ["A", "a/b"],
  ])
    expect(() =>
      validateDeploymentSource(paths.map((path) => ({ path, content: "" }))),
    ).toThrow();
});

test("rejects malformed, empty and oversized snapshots before materialization", () => {
  for (const files of [
    null,
    [],
    [{ path: "a", content: 1 }],
    [{ path: "a", content: "", mode: "symlink" }],
  ])
    expect(() => validateDeploymentSource(files)).toThrow("invalid");
  expect(() =>
    validateDeploymentSource([
      { path: "a", content: "a".repeat(2 * 1024 * 1024) },
    ]),
  ).toThrow("byte limit");
});
