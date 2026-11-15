import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readGitHubSnapshot } from "../../src/providers/github/snapshot";
const repository = {
  provider: "github" as const,
  id: "12",
  owner: "studio",
  name: "notes",
  private: true,
};
const commitId = "a".repeat(40),
  treeId = "b".repeat(40);
const content = "export default 1;\n";
const bytes = Buffer.from(content);
const blobId = createHash("sha1")
  .update(`blob ${bytes.length}\0`)
  .update(bytes)
  .digest("hex");
function fixture(change?: (path: string, value: unknown) => unknown): {
  get(path: string): Promise<unknown>;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      let value: unknown;
      if (path === "/repositories/12")
        value = {
          id: 12,
          owner: { login: "studio" },
          name: "notes",
          private: true,
          archived: false,
          disabled: false,
        };
      else if (path.endsWith(`/git/commits/${commitId}`))
        value = { sha: commitId, tree: { sha: treeId } };
      else if (path.endsWith("?recursive=1"))
        value = {
          sha: treeId,
          truncated: false,
          tree: [
            {
              path: "app/page.tsx",
              mode: "100644",
              type: "blob",
              sha: blobId,
              size: bytes.length,
            },
            {
              path: ".env",
              mode: "100644",
              type: "blob",
              sha: "c".repeat(40),
              size: 20,
            },
          ],
        };
      else if (path.endsWith(blobId))
        value = {
          sha: blobId,
          size: bytes.length,
          encoding: "base64",
          content: bytes.toString("base64") + "\n",
        };
      else throw new Error("Unexpected request");
      return change ? change(path, value) : value;
    },
  };
}
test("snapshot pins immutable objects, verifies content and never downloads excluded secrets", async () => {
  const client = fixture();
  const result = await readGitHubSnapshot(client, repository, commitId);
  expect(result.files).toEqual([{ path: "app/page.tsx", content }]);
  expect(result.excludedPaths).toEqual([".env"]);
  expect(client.paths).toHaveLength(4);
  expect(client.paths.join(" ")).not.toContain("/heads/");
});
test("snapshot rejects changed identities and blobs rather than saving partial source", async () => {
  await expect(
    readGitHubSnapshot(
      fixture((path, value) =>
        path === "/repositories/12" ? { ...(value as object), id: 13 } : value,
      ),
      repository,
      commitId,
    ),
  ).rejects.toThrow("identity_changed");
  await expect(
    readGitHubSnapshot(
      fixture((path, value) =>
        path.endsWith(blobId)
          ? {
              ...(value as object),
              content: Buffer.from("x".repeat(bytes.length)).toString("base64"),
            }
          : value,
      ),
      repository,
      commitId,
    ),
  ).rejects.toThrow("invalid_content");
  const client = fixture();
  await expect(
    readGitHubSnapshot(client, repository, "main"),
  ).rejects.toThrow();
  expect(client.paths).toHaveLength(0);
  const controller = new AbortController();
  controller.abort();
  await expect(
    readGitHubSnapshot(client, repository, commitId, controller.signal),
  ).rejects.toThrow();
  expect(client.paths).toHaveLength(0);
});

test("blob reads are bounded and preserve tree order despite out-of-order completion", async () => {
  let active = 0;
  let peak = 0;
  const source = Array.from({ length: 9 }, (_, index) => {
    const content = `export default ${index};`;
    const bytes = Buffer.from(content);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return { path: `app/file-${index}.ts`, content, bytes, sha };
  });
  const base = fixture();
  const client = {
    async get(path: string): Promise<unknown> {
      if (path.endsWith("?recursive=1")) return {
        sha: treeId, truncated: false,
        tree: source.map((file) => ({ path: file.path, mode: "100644", type: "blob", sha: file.sha, size: file.bytes.length })),
      };
      const index = source.findIndex((file) => path.endsWith(file.sha));
      if (index < 0) return base.get(path);
      const file = source[index]!;
      active++;
      peak = Math.max(peak, active);
      try {
        await Bun.sleep(index === 0 ? 20 : 1);
        return { sha: file.sha, size: file.bytes.length, encoding: "base64", content: file.bytes.toString("base64") };
      } finally { active--; }
    },
  };
  const result = await readGitHubSnapshot(client, repository, commitId);
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(result.files).toEqual(source.map(({ path, content }) => ({ path, content })));
});

test("a failed blob cancels outstanding reads and never returns a partial snapshot", async () => {
  const failure = new Error("fixture read failed");
  let started = 0;
  let settled = 0;
  const base = fixture();
  const client = {
    async get(path: string, signal?: AbortSignal): Promise<unknown> {
      if (path.endsWith("?recursive=1")) return {
        sha: treeId, truncated: false,
        tree: Array.from({ length: 9 }, (_, index) => ({ path: `file-${index}.ts`, mode: "100644", type: "blob", sha: blobId, size: bytes.length })),
      };
      if (!path.endsWith(blobId)) return base.get(path);
      const index = started++;
      try {
        if (index === 0) { await Bun.sleep(1); throw failure; }
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        signal?.throwIfAborted();
        throw new Error("Expected cancellation");
      } finally { settled++; }
    },
  };
  await expect(readGitHubSnapshot(client, repository, commitId)).rejects.toBe(failure);
  expect(started).toBe(4);
  expect(settled).toBe(started);
});
