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
