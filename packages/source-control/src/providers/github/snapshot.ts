import { DEFAULT_IMPORT_LIMITS, type SourceImportLimits } from "../../policy/import-policy";
import { createSourceAsset } from "../../revision/assets";
/**
 * COMPONENT: Immutable repository reader
 * PURPOSE: Download one exact commit without running any repository code.
 * INPUTS: An authorized read client, reviewed repository identity and commit SHA.
 * OUTPUTS: Bounded UTF-8 source, excluded paths and the pinned commit/tree identity.
 * STEPS: Recheck repository, resolve commit tree, validate entries, verify each Git blob.
 * EDGE CASES: Branch movement cannot retarget immutable SHA requests; unsupported content either fails closed or classifies for review consent.
 * ERROR STATES: Reject identity changes, incomplete trees, changed hashes and cancellation.
 */
import {
  SourceControlError,
  type SourceFile,
  type SourceImportRiskCode,
  type SourceImportRiskFlag,
  type SourceRepository,
  type SourceTreeEntry,
} from "../../contracts/source";
import { validateApplicationRoot } from "../../policy/application-root";
import { validateSourceFiles } from "../../policy/import-policy";
import type { GitHubReadClient } from "./http-client";
import { readGitHubRepository, readGitHubSourceTree } from "./repository";
const SHA = /^[a-f0-9]{40}$/;
const SNAPSHOT_TIMEOUT_MS = 60_000;
const INTERACTIVE_SNAPSHOT_TIMEOUT_MS = 180_000;
const ASSET_PATTERN = /\.(?:png|jpe?g|webp|ico|woff2?|ttf|otf)$/i;
// Keep provider requests and decoded response bodies bounded without serializing the whole tree.
const MAX_CONCURRENT_BLOB_READS = 4;
const INTERACTIVE_CONCURRENT_BLOB_READS = 12;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export interface GitHubSourceSnapshot {
  repository: SourceRepository;
  applicationRoot?: string;
  commitId: string;
  treeId: string;
  files: SourceFile[];
  excludedPaths: string[];
  textBytes?: number;
  assetBytes?: number;
  totalBytes?: number;
  riskFlags?: SourceImportRiskFlag[];
}
const RISK_DESCRIPTIONS: Record<
  SourceImportRiskCode,
  { title: string; detail: string }
> = {
  private_env: {
    title: "Private environment or credential files",
    detail:
      "Environment secrets, keys, or sample APP_KEY placeholders were detected. Clean import keeps secrets out of Wrenly.",
  },
  runtime_caches: {
    title: "Generated caches or runtime storage",
    detail:
      "Cache/storage directories (.next, .turbo, bootstrap/cache, storage) are excluded or cleared so builds regenerate fresh output.",
  },
  installed_dependencies: {
    title: "Committed dependency directories",
    detail:
      "vendor/ or node_modules/ folders were found. Dependencies install cleanly from lockfiles inside the sandbox.",
  },
  package_scripts: {
    title: "Custom Composer or npm scripts",
    detail:
      "Lifecycle hooks or extra package scripts run disabled inside Wrenly's isolated sandbox; clean import normalizes these manifests.",
  },
  unverified_version: {
    title: "Framework or styling compatibility warning",
    detail:
      "This framework version or CSS pipeline is outside the verified Next.js 15/16 and Laravel 12/13 runtime matrix.",
  },
  unsupported_files: {
    title: "Skipped binary, LFS, or special Git entries",
    detail:
      "Unsupported binaries, symlinks, submodules, or Git LFS files were excluded from this snapshot.",
  },
};
export function buildRiskFlag(code: SourceImportRiskCode, paths: string[]): SourceImportRiskFlag {
  const meta = RISK_DESCRIPTIONS[code];
  return {
    code,
    title: meta.title,
    detail: meta.detail,
    paths: paths.slice(0, 50),
  };
}
/** Verify Git's content identity, including the byte count, before interpreting text. */
async function decodeBlob(
  raw: unknown,
  id: string,
  size: number,
): Promise<Uint8Array> {
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
    !/^[A-Za-z0-9+/]*={0,2}$/.test(
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
  return bytes;
}
/** Callers must recheck local account authority before saving or exposing the returned snapshot. */
export async function readGitHubSnapshot(
  client: GitHubReadClient,
  expected: SourceRepository,
  commitId: string,
  externalSignal?: AbortSignal,
  applicationRoot = "",
  limits: SourceImportLimits = DEFAULT_IMPORT_LIMITS,
  options?: {
    interactiveReview?: boolean;
    beforeReadBlobs?: (
      entries: readonly SourceTreeEntry[],
      readBlobText: (entry: SourceTreeEntry) => Promise<string>,
    ) => Promise<void>;
  },
): Promise<GitHubSourceSnapshot> {
  validateApplicationRoot(applicationRoot);
  if (!SHA.test(commitId)) throw new SourceControlError("invalid_tree");
  const interactive = options?.interactiveReview === true;
  const snapshotTimeoutMs = interactive
    ? INTERACTIVE_SNAPSHOT_TIMEOUT_MS
    : SNAPSHOT_TIMEOUT_MS;
  const signal = externalSignal
    ? AbortSignal.any([
        externalSignal,
        AbortSignal.timeout(snapshotTimeoutMs),
      ])
    : AbortSignal.timeout(snapshotTimeoutMs);
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
    applicationRoot,
    limits,
    options,
  );
  const prefetchedBlobs = new Map<string, Uint8Array>();
  async function fetchEntryBytes(
    entry: SourceTreeEntry,
    readSig: AbortSignal,
  ): Promise<Uint8Array> {
    const cached = prefetchedBlobs.get(entry.blobId);
    if (cached) return cached;
    const raw = await client.get(`${root}/git/blobs/${entry.blobId}`, readSig);
    readSig.throwIfAborted();
    const bytes = await decodeBlob(raw, entry.blobId, entry.size);
    prefetchedBlobs.set(entry.blobId, bytes);
    return bytes;
  }
  if (options?.beforeReadBlobs) {
    await options.beforeReadBlobs(tree.entries, async (entry) => {
      const bytes = await fetchEntryBytes(entry, signal);
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    });
    signal.throwIfAborted();
  }
  const decoded: Array<SourceFile | null> = new Array(tree.entries.length).fill(null);
  const extraExcluded: string[] = [];
  const riskMap = new Map<SourceImportRiskCode, string[]>();
  for (const [code, bucket] of Object.entries(tree.riskPaths ?? {}) as Array<[SourceImportRiskCode, string[] | undefined]>) {
    if (bucket?.length) riskMap.set(code, [...bucket]);
  }
  const addRiskPath = (code: SourceImportRiskCode, path: string): void => {
    const existing = riskMap.get(code) ?? [];
    if (existing.length < 250 && !existing.includes(path)) existing.push(path);
    riskMap.set(code, existing);
  };
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
        const bytes = await fetchEntryBytes(entry, readSignal);
        readSignal.throwIfAborted();
        // Completion order must never change the saved tree or its review identity.
        if (ASSET_PATTERN.test(entry.path)) {
          try {
            decoded[index] = {
              path: entry.path,
              content: "",
              asset: createSourceAsset(entry.path, bytes, limits.assetFileBytes),
            };
          } catch {
            if (interactive) {
              extraExcluded.push(entry.path);
              addRiskPath("unsupported_files", entry.path);
              continue;
            }
            throw new SourceControlError("invalid_content", entry.path);
          }
        } else {
          try {
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            if (
              /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ||
              text.startsWith("version https://git-lfs.github.com/spec/v1") ||
              Buffer.from(text, "utf8").toString("utf8") !== text
            ) {
              if (interactive) {
                extraExcluded.push(entry.path);
                addRiskPath("unsupported_files", entry.path);
                continue;
              }
              throw new SourceControlError("invalid_content", entry.path);
            }
            decoded[index] = { path: entry.path, content: text };
          } catch (error) {
            if (interactive && !(error instanceof SourceControlError)) {
              extraExcluded.push(entry.path);
              addRiskPath("unsupported_files", entry.path);
              continue;
            }
            if (interactive && error instanceof SourceControlError && error.code === "invalid_content") {
              extraExcluded.push(entry.path);
              addRiskPath("unsupported_files", entry.path);
              continue;
            }
            throw error instanceof SourceControlError
              ? error
              : new SourceControlError("invalid_content", entry.path);
          }
        }
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
        controller.abort();
      }
    }
  }
  const concurrency = interactive
    ? INTERACTIVE_CONCURRENT_BLOB_READS
    : MAX_CONCURRENT_BLOB_READS;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, tree.entries.length) },
      () => readWorker(),
    ),
  );
  // Wait for every outstanding read to settle before returning any error or source.
  if (failed) throw failure;
  signal.throwIfAborted();
  const compactFiles = decoded.filter((item): item is SourceFile => item !== null);
  const validatedFiles = validateSourceFiles(compactFiles, limits);
  let textBytes = 0;
  let assetBytes = 0;
  for (const file of validatedFiles) {
    if (file.asset) assetBytes += file.asset.byteLength;
    else textBytes += Buffer.byteLength(file.content, "utf8");
  }
  const excludedPaths = [...tree.excludedPaths, ...extraExcluded];
  const riskFlags: SourceImportRiskFlag[] = Array.from(riskMap.entries()).map(([code, paths]) =>
    buildRiskFlag(code, paths),
  );
  return {
    repository,
    applicationRoot,
    commitId,
    treeId,
    files: validatedFiles,
    excludedPaths,
    ...(interactive
      ? {
          textBytes,
          assetBytes,
          totalBytes: textBytes + assetBytes,
          riskFlags,
        }
      : {}),
  };
}
