/**
 * COMPONENT: Immutable repository reader
 * PURPOSE: Download one exact commit without running any repository code.
 * INPUTS: An authorized read client, reviewed repository identity and commit SHA.
 * OUTPUTS: Bounded UTF-8 source, excluded paths and the pinned commit/tree identity.
 * STEPS: Recheck repository, resolve commit tree, validate entries, verify each Git blob.
 * EDGE CASES: Branch movement cannot retarget immutable SHA requests; binary files fail closed.
 * ERROR STATES: Reject identity changes, incomplete trees, changed hashes and cancellation.
 */
import {
  SourceControlError,
  type SourceFile,
  type SourceRepository,
} from "../../contracts/source";
import { validateSourceFiles } from "../../policy/import-policy";
import type { GitHubReadClient } from "./http-client";
import { readGitHubRepository, readGitHubSourceTree } from "./repository";
const SHA = /^[a-f0-9]{40}$/;
const SNAPSHOT_TIMEOUT_MS = 60_000;
// Keep provider requests and decoded response bodies bounded without serializing the whole tree.
const MAX_CONCURRENT_BLOB_READS = 4;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export interface GitHubSourceSnapshot {
  repository: SourceRepository;
  commitId: string;
  treeId: string;
  files: SourceFile[];
  excludedPaths: string[];
}
/** Verify Git's content identity, including the byte count, before interpreting text. */
async function decodeBlob(
  raw: unknown,
  id: string,
  size: number,
): Promise<string> {
  if (
    !record(raw) ||
    raw.sha !== id ||
    raw.size !== size ||
    raw.encoding !== "base64" ||
    typeof raw.content !== "string"
  )
    throw new SourceControlError("invalid_content");
  const encoded = raw.content.replace(/\n/g, "");
  if (
    encoded.length !== 4 * Math.ceil(size / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new SourceControlError("invalid_content");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== encoded)
    throw new SourceControlError("invalid_content");
  const header = new TextEncoder().encode(`blob ${size}\0`);
  const object = new Uint8Array(header.length + size);
  object.set(header);
  object.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", object);
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== id) throw new SourceControlError("invalid_content");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SourceControlError("invalid_content");
  }
}
/** Callers must recheck local account authority before saving or exposing the returned snapshot. */
export async function readGitHubSnapshot(
  client: GitHubReadClient,
  expected: SourceRepository,
  commitId: string,
  externalSignal?: AbortSignal,
): Promise<GitHubSourceSnapshot> {
  if (!SHA.test(commitId)) throw new SourceControlError("invalid_tree");
  const signal = externalSignal
    ? AbortSignal.any([
        externalSignal,
        AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS);
  signal.throwIfAborted();
  const repository = readGitHubRepository(
    await client.get(`/repositories/${expected.id}`, signal),
    expected,
  );
  const root = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const commit = await client.get(`${root}/git/commits/${commitId}`, signal);
  if (
    !record(commit) ||
    commit.sha !== commitId ||
    !record(commit.tree) ||
    typeof commit.tree.sha !== "string" ||
    !SHA.test(commit.tree.sha)
  )
    throw new SourceControlError("invalid_tree");
  const treeId = commit.tree.sha;
  const tree = readGitHubSourceTree(
    await client.get(`${root}/git/trees/${treeId}?recursive=1`, signal),
    treeId,
  );
  const files: SourceFile[] = new Array(tree.entries.length);
  const controller = new AbortController();
  const readSignal = AbortSignal.any([signal, controller.signal]);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  async function readWorker(): Promise<void> {
    try {
      while (!readSignal.aborted) {
        const index = nextIndex++;
        const entry = tree.entries[index];
        if (!entry) return;
        const raw = await client.get(`${root}/git/blobs/${entry.blobId}`, readSignal);
        readSignal.throwIfAborted();
        const content = await decodeBlob(raw, entry.blobId, entry.size);
        readSignal.throwIfAborted();
        // Completion order must never change the saved tree or its review identity.
        files[index] = { path: entry.path, content };
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
        controller.abort();
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_BLOB_READS, tree.entries.length) },
      () => readWorker(),
    ),
  );
  // Wait for every outstanding read to settle before returning any error or source.
  if (failed) throw failure;
  signal.throwIfAborted();
  return {
    repository,
    commitId,
    treeId,
    files: validateSourceFiles(files),
    excludedPaths: tree.excludedPaths,
  };
}
