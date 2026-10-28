import { expect, test } from "bun:test";
import { buildSourceTree } from "../../source-tree";

test("directories sort before files at every level without changing source indexes", () => {
  const files = [
    { path: "z.ts" },
    { path: "app/z.ts" },
    { path: "app/components/b.tsx" },
    { path: "app/a.ts" },
    { path: "a.ts" },
  ];
  const tree = buildSourceTree(files);
  expect(tree.map((node) => node.name)).toEqual(["app", "a.ts", "z.ts"]);
  const app = tree[0];
  if (app?.kind !== "folder") throw new Error("Missing app directory");
  expect(app.children.map((node) => node.name)).toEqual([
    "components",
    "a.ts",
    "z.ts",
  ]);
  expect(app.children[1]).toMatchObject({
    kind: "file",
    path: "app/a.ts",
    index: 3,
  });
  expect(files.map((file) => file.path)).toEqual([
    "z.ts",
    "app/z.ts",
    "app/components/b.tsx",
    "app/a.ts",
    "a.ts",
  ]);
});
test("search keeps matching ancestors and original source identities", () => {
  const tree = buildSourceTree(
    [
      { path: "package.json" },
      { path: "app/components/Card.tsx" },
      { path: "app/page.tsx" },
    ],
    " card ",
  );
  const app = tree[0];
  if (app?.kind !== "folder") throw new Error("Missing ancestor");
  const components = app.children[0];
  if (components?.kind !== "folder") throw new Error("Missing nested ancestor");
  expect(components.children).toEqual([
    {
      kind: "file",
      name: "Card.tsx",
      path: "app/components/Card.tsx",
      index: 1,
    },
  ]);
  expect(buildSourceTree([{ path: "app/page.tsx" }], "absent")).toEqual([]);
});
test("same-name file and directory stay separate and special names are plain data", () => {
  const tree = buildSourceTree([
    { path: "__proto__/x.ts" },
    { path: "app" },
    { path: "app/page.tsx" },
  ]);
  expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
    "folder:__proto__",
    "folder:app",
    "file:app",
  ]);
  expect(buildSourceTree([])).toEqual([]);
});
