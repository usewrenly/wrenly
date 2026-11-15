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
  ).rejects.toThrow("Next.js 15");
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
