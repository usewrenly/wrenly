import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readImportSource } from "../import-reader";
import type { GitHubReadClient } from "@wrenly/source-control";
function fixture(version = "15.5.28"): GitHubReadClient & { paths: string[] } {
  const content = JSON.stringify({ dependencies: { next: version } });
  const sha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");
  const paths: string[] = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      if (path === "/repositories/12")
        return {
          id: 12,
          owner: { login: "studio" },
          name: "notes",
          private: true,
          archived: false,
          disabled: false,
        };
      if (path.endsWith("/git/ref/heads/main"))
        return { object: { type: "commit", sha: "a".repeat(40) } };
      if (path.endsWith("/git/commits/" + "a".repeat(40)))
        return { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } };
      if (path.endsWith("?recursive=1"))
        return {
          sha: "b".repeat(40),
          truncated: false,
          tree: [
            {
              path: "package.json",
              mode: "100644",
              type: "blob",
              sha,
              size: Buffer.byteLength(content),
            },
          ],
        };
      if (path.endsWith("/git/blobs/" + sha))
        return {
          sha,
          size: Buffer.byteLength(content),
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
        };
      throw new Error("Unexpected request");
    },
  };
}
test("review resolves a branch once and retains the exact commit and original manifest", async () => {
  const client = fixture();
  const review = await readImportSource(
    client,
    { repositoryId: "12", ref: "main", stack: "nextjs" },
    new AbortController().signal,
  );
  expect(review.snapshot.commitId).toBe("a".repeat(40));
  expect(
    client.paths.filter((path) => path.includes("/git/ref/")),
  ).toHaveLength(1);
  expect(review.snapshot.files[0]?.content).toContain("15.5.28");
});
test("unsupported framework versions are rejected rather than silently upgraded", async () => {
  await expect(
    readImportSource(
      fixture("14.2.0"),
      { repositoryId: "12", ref: "main", stack: "nextjs" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Next.js 15 or 16");
  const client = fixture();
  await expect(
    readImportSource(
      client,
      { repositoryId: "12", ref: "../main", stack: "nextjs" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("regular branch");
  expect(client.paths).toHaveLength(0);
});

test("empty branch selection resolves the actual repository default instead of guessing main", async () => {
  const base = fixture();
  const paths: string[] = [];
  const client: GitHubReadClient = {
    get: async (path, signal) => {
      paths.push(path);
      if (path === "/repositories/12")
        return {
          ...((await base.get(path, signal)) as Record<string, unknown>),
          default_branch: "master",
        };
      return base.get(path.replace("/heads/master", "/heads/main"), signal);
    },
  };
  const review = await readImportSource(
    client,
    { repositoryId: "12", ref: "", stack: "nextjs" },
    new AbortController().signal,
  );
  expect(review.snapshot.commitId).toBe("a".repeat(40));
  expect(paths.some((path) => path.endsWith("/heads/master"))).toBe(true);
  expect(paths.some((path) => path.endsWith("/heads/main"))).toBe(false);
});

for (const version of ["15.5.29", "^15.5.29", "16.4.5", "~16.4.5"]) {
  test(`review preserves Next.js ${version} without conversion`, async () => {
    const result = await readImportSource(fixture(version), { repositoryId: "12", ref: "main", stack: "nextjs" }, new AbortController().signal);
    expect(JSON.parse(result.snapshot.files[0]!.content).dependencies.next).toBe(version);
  });
}
for (const version of ["latest", ">=15", "^16.0.0 || ^17.0.0", "16.0.0-canary.1", "17.0.0"]) {
  test(`review rejects ambiguous or unverified version ${version}`, async () => {
    await expect(readImportSource(fixture(version), { repositoryId: "12", ref: "main", stack: "nextjs" }, new AbortController().signal)).rejects.toThrow("version");
  });
}

test("review detects the framework when no manual family is supplied", async () => {
  const review = await readImportSource(fixture("16.4.5"), { repositoryId: "12", ref: "main" }, new AbortController().signal);
  expect(review.stack).toBe("nextjs");
  expect(review.snapshot.files[0]?.content).toContain("16.4.5");
});

test('review detects a standalone application in a chosen directory without fetching sibling blobs', async () => {
  const base = fixture('16.4.5');
  const client: GitHubReadClient = { async get(path, signal) {
    const raw = await base.get(path, signal);
    if (!path.endsWith('?recursive=1')) return raw;
    const value = raw as { tree: Array<{ path: string }> };
    return { ...(raw as object), tree: [
      ...value.tree.map(entry => ({ ...entry, path: `apps/web/${entry.path}` })),
      { path: 'apps/other/image.png', mode: '100644', type: 'blob', sha: 'f'.repeat(40), size: 100_000_000 },
    ] };
  } };
  const result = await readImportSource(client, { repositoryId: '12', ref: 'main', applicationRoot: 'apps/web' }, new AbortController().signal);
  expect(result.stack).toBe('nextjs');
  expect(result.snapshot.applicationRoot).toBe('apps/web');
  expect(result.snapshot.files.map(file => file.path)).toEqual(['package.json']);
  expect(base.paths.some(path => path.includes('f'.repeat(40)))).toBe(false);
});

function buildRepoClient(entries: Record<string, string>): GitHubReadClient {
  const bySha = new Map<string, { content: string; sha: string }>();
  const tree = Object.entries(entries).map(([path, content]) => {
    const sha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0${content}`)
      .digest("hex");
    bySha.set(sha, { content, sha });
    return {
      path,
      mode: "100644",
      type: "blob",
      sha,
      size: Buffer.byteLength(content),
    };
  });
  return {
    async get(path) {
      if (path === "/repositories/12") {
        return {
          id: 12,
          owner: { login: "studio" },
          name: "softe",
          private: true,
          archived: false,
          disabled: false,
          size: 512,
        };
      }
      if (path.endsWith("/git/ref/heads/main")) {
        return { object: { type: "commit", sha: "a".repeat(40) } };
      }
      if (path.endsWith("/git/commits/" + "a".repeat(40))) {
        return { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } };
      }
      if (path.endsWith("?recursive=1")) {
        return { sha: "b".repeat(40), truncated: false, tree };
      }
      const match = path.match(/\/git\/blobs\/([a-f0-9]{40})$/);
      const blob = match?.[1] ? bySha.get(match[1]) : undefined;
      if (blob) {
        return {
          sha: blob.sha,
          size: Buffer.byteLength(blob.content),
          encoding: "base64",
          content: Buffer.from(blob.content, "utf8").toString("base64"),
        };
      }
      throw new Error(`Unexpected path ${path}`);
    },
  };
}

test("allowRiskReview classifies Laravel caches, APP_KEY, and Composer/npm scripts without blocking review", async () => {
  const client = buildRepoClient({
    "composer.json": JSON.stringify({
      name: "studio/softe",
      type: "project",
      require: { "laravel/framework": "^12.0" },
      scripts: { "post-autoload-dump": ["@php artisan package:discover"] },
      config: { "optimize-autoloader": true, "allow-plugins": true },
    }),
    "composer.lock": JSON.stringify({ packages: [] }),
    "package.json": JSON.stringify({
      private: true,
      scripts: { dev: "vite", build: "vite build" },
    }),
    ".env": "APP_KEY=base64:secretvalue\n",
    ".env.example": "APP_NAME=Softe\nAPP_KEY=base64:sample\n",
    artisan: "#!/usr/bin/env php\n",
    "bootstrap/app.php": "<?php\n",
    "bootstrap/providers.php": "<?php\nreturn [];\n",
    "bootstrap/cache/packages.php": "<?php\nreturn [];\n",
    "storage/framework/cache/data": "cached",
    "routes/web.php": "<?php\n",
    "routes/console.php": "<?php\n",
    "public/index.php": "<?php\n",
    "config/app.php": "<?php\n",
    "config/session.php": "<?php\n",
    "config/cache.php": "<?php\n",
    "config/logging.php": "<?php\n",
  });

  const result = await readImportSource(
    client,
    { repositoryId: "12", ref: "main", stack: "auto" },
    new AbortController().signal,
    undefined,
    { allowRiskReview: true },
  );

  expect(result.stack).toBe("laravel");
  expect(result.snapshot.repository.sizeKb).toBe(512);
  expect((result.snapshot.totalBytes ?? 0) > 0).toBe(true);
  expect(result.snapshot.excludedPaths).toContain(".env");
  expect(result.snapshot.excludedPaths).toContain("storage/framework/cache/data");
  expect(result.snapshot.excludedPaths).toContain("bootstrap/cache/packages.php");
  const codes = result.riskFlags.map((flag) => flag.code);
  expect(codes).toContain("private_env");
  expect(codes).toContain("runtime_caches");
  expect(codes).toContain("package_scripts");

  const sanitizedComposer = JSON.parse(
    result.snapshot.files.find((f) => f.path === "composer.json")!.content,
  ) as Record<string, unknown>;
  expect("scripts" in sanitizedComposer).toBe(false);
  const envExample = result.snapshot.files.find((f) => f.path === ".env.example")!.content;
  expect(envExample).not.toMatch(/APP_KEY=/);
});

test("allowRiskReview flags Next.js 14 version instead of blocking review", async () => {
  const client = buildRepoClient({
    "package.json": JSON.stringify({
      dependencies: { next: "^14.2.5", react: "^18.3.0" },
    }),
    "app/layout.tsx": "export default function RootLayout() { return null; }\n",
  });

  const result = await readImportSource(
    client,
    { repositoryId: "12", ref: "main", stack: "auto" },
    new AbortController().signal,
    undefined,
    { allowRiskReview: true },
  );

  expect(result.stack).toBe("nextjs");
  expect(result.riskFlags.some((f) => f.code === "unverified_version")).toBe(true);
});

test("allowRiskReview suggests nested monorepo directories when root has no framework app", async () => {
  const client = buildRepoClient({
    "package.json": JSON.stringify({ name: "monorepo", private: true }),
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "^16.4.6" } }),
    "apps/docs/package.json": JSON.stringify({ dependencies: { next: "^16.4.6" } }),
  });

  await expect(
    readImportSource(
      client,
      { repositoryId: "12", ref: "main", stack: "auto" },
      new AbortController().signal,
      undefined,
      { allowRiskReview: true },
    ),
  ).rejects.toThrow("apps/docs, apps/web");
});

test("allowRiskReview accepts next@latest without flagging an old or unverified version", async () => {
  const client = buildRepoClient({
    "package.json": JSON.stringify({
      dependencies: { next: "latest", react: "latest" },
    }),
    "app/layout.tsx":
      "import './globals.css'; export default function RootLayout({ children }: { children: unknown }) { return children; }\n",
    "app/globals.css": "@import 'tailwindcss';\n",
  });

  const result = await readImportSource(
    client,
    { repositoryId: "12", ref: "main", stack: "auto" },
    new AbortController().signal,
    undefined,
    { allowRiskReview: true },
  );

  expect(result.stack).toBe("nextjs");
  expect(result.riskFlags.some((f) => f.code === "unverified_version")).toBe(
    false,
  );
});

test("allowRiskReview rejects monorepo root before downloading unrelated source blobs", async () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "monorepo", private: true }),
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "^16.4.6" } }),
    "apps/docs/package.json": JSON.stringify({ dependencies: { next: "^16.4.6" } }),
  };
  for (let i = 0; i < 45; i++) {
    files[`packages/shared/file-${i}.ts`] = `export const n${i} = ${i};\n`;
  }
  const inner = buildRepoClient(files);
  let blobFetches = 0;
  const countingClient: GitHubReadClient = {
    async get(path, signal) {
      if (path.includes("/git/blobs/")) blobFetches++;
      return inner.get(path, signal);
    },
  };

  await expect(
    readImportSource(
      countingClient,
      { repositoryId: "12", ref: "main", stack: "auto" },
      new AbortController().signal,
      undefined,
      { allowRiskReview: true },
    ),
  ).rejects.toThrow("apps/docs, apps/web");
  expect(blobFetches).toBe(3);
});
