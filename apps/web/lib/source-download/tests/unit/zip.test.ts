import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceZip, MAX_SOURCE_BYTES, MAX_SOURCE_FILES } from "../../zip";

test("ZIP is independently readable and preserves nested Unicode paths, empty files and exact text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-source-zip-"));
  const files = [
    { path: "app/こんにちは.tsx", content: "export default 'hello 👋';\n" },
    { path: "empty.txt", content: "" },
    { path: "docs/Getting started.md", content: "Instructions with a safe space in the path" },
    { path: "app/(marketing)/[slug]/page.tsx", content: "export default function Page() { return null }" },
    { path: "bom.txt", content: "\ufeffKeep this BOM\n" },
    { path: "package.json", content: '{"private":true}\n' },
  ];
  try {
    const path = join(directory, "source.zip");
    await Bun.write(path, createSourceZip(files));
    const child = Bun.spawn(
      [
        "python3",
        "-c",
        "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([{'path':n,'content':z.read(n).decode('utf-8')} for n in z.namelist()]))",
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual(files);
    expect(
      new DataView(
        createSourceZip([{ path: "crc.txt", content: "123456789" }]).buffer,
      ).getUint32(14, true),
    ).toBe(0xcbf43926);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsafe paths, extraction collisions and bounds fail without truncating source", () => {
  for (const path of [
    "../secret",
    "/absolute",
    "C:/file",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
    "nul.txt",
    "a/COM1",
    "a/space ",
    "a/end.",
    "a\0b",
    "bad\ud800",
  ])
    expect(() => createSourceZip([{ path, content: "x" }])).toThrow();
  for (const paths of [
    ["a", "a"],
    ["A.ts", "a.ts"],
    ["é.ts", "e\u0301.ts"],
    ["a", "a/b"],
  ])
    expect(() =>
      createSourceZip(paths.map((path) => ({ path, content: "x" }))),
    ).toThrow();
  expect(() => createSourceZip([])).toThrow();
  expect(() =>
    createSourceZip(
      Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => ({
        path: `${index}.ts`,
        content: "",
      })),
    ),
  ).toThrow();
  expect(() =>
    createSourceZip([
      { path: "large.txt", content: "x".repeat(MAX_SOURCE_BYTES + 1) },
    ]),
  ).toThrow("byte limit");
});

test('ZIP preserves imported image bytes independently of model-visible source', async () => {
  const { createSourceAsset } = await import('@wrenly/source-control');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPoLYj5DwAFQAJZssNTVgAAAABJRU5ErkJggg==', 'base64');
  const directory=await mkdtemp(join(tmpdir(),'wrenly-asset-zip-'));
  try {
    const path=join(directory,'assets.zip');
    await Bun.write(path,createSourceZip([{ path:'public/logo.png',content:'',asset:createSourceAsset('public/logo.png',png) }]));
    const reader=Bun.spawn(['python3','-c',"import sys,zipfile,base64; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(base64.b64encode(z.read('public/logo.png')).decode())",path],{stdout:'pipe',stderr:'pipe'});
    expect(await new Response(reader.stdout).text()).toBe(png.toString('base64')+'\n');
    expect(await reader.exited).toBe(0);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
