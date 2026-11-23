import {
  DEFAULT_IMPORT_LIMITS,
  classifyInteractiveExclusion,
  type SourceImportLimits,
} from "../../policy/import-policy";
/** GitHub response decoding; no network requests, tokens or authorization decisions live here. */
import {
  SourceControlError,
  type SourceImportRiskCode,
  type SourceRepository,
  type SourceTreeEntry,
} from "../../contracts/source";
import {
  assertDistinctSourcePaths,
  assertSourcePath,
  shouldExcludeSourcePath,
} from "../../policy/import-policy";
import { validateApplicationRoot } from "../../policy/application-root";
const MAX_TREE_ENTRIES = 4096; // Bound metadata too, including excluded files and directories.
const ASSET_PATTERN = /\.(?:png|jpe?g|webp|ico|woff2?|ttf|otf)$/i;
const SKIPPABLE_BINARY_PATTERN =
  /(?:^|\/)\.DS_Store$|\.(?:pdf|zip|tar|gz|tgz|7z|rar|mp4|mov|webm|mp3|wav|ogg|avi|mkv|sqlite3?|db|exe|dll|so|dylib|bin|dmg|iso|avif|heic|heif|lockb|map|gif|bmp|tiff?|psd|ai|fig|sketch|wasm|pyc|pyo|class|jar|war|ear|o|a|obj|pdb)$/i;
const SHA = /^[a-f0-9]{40}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function name(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(value)
  );
}
/** Pin GitHub's numeric identity; a renamed repository must be reviewed rather than silently followed. */
export function readGitHubRepository(
  value: unknown,
  expected?: SourceRepository,
): SourceRepository {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    !name(value.name) ||
    !record(value.owner) ||
    !name(value.owner.login) ||
    typeof value.private !== "boolean" ||
    value.disabled !== false ||
    value.archived !== false
  )
    throw new SourceControlError("invalid_repository");
  const sizeKb =
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
      ? value.size
      : undefined;
  const repository: SourceRepository = {
    provider: "github",
    id: String(value.id),
    owner: value.owner.login,
    name: value.name,
    private: value.private,
    ...(sizeKb !== undefined ? { sizeKb } : {}),
  };
  if (
    expected &&
    (expected.provider !== repository.provider ||
      expected.id !== repository.id ||
      expected.owner !== repository.owner ||
      expected.name !== repository.name ||
      expected.private !== repository.private)
  )
    throw new SourceControlError("identity_changed");
  return repository;
}
/** Decode a complete recursive tree identified by a previously pinned immutable tree SHA. */
export function readGitHubSourceTree(
  value: unknown,
  expectedTreeId: string,
  applicationRoot = "",
  limits: SourceImportLimits = DEFAULT_IMPORT_LIMITS,
  options?: { interactiveReview?: boolean },
): {
  entries: SourceTreeEntry[];
  excludedPaths: string[];
  riskPaths?: Partial<Record<SourceImportRiskCode, string[]>>;
} {
  const interactive = options?.interactiveReview === true;
  const maxRawEntries = interactive ? Math.max(100_000, limits.files * 20) : MAX_TREE_ENTRIES;
  if (
    !SHA.test(expectedTreeId) ||
    !record(value) ||
    value.sha !== expectedTreeId ||
    value.truncated !== false ||
    !Array.isArray(value.tree) ||
    value.tree.length > maxRawEntries
  )
    throw new SourceControlError("invalid_tree");
  validateApplicationRoot(applicationRoot);
  const prefix = applicationRoot ? `${applicationRoot}/` : "";
  const entries: SourceTreeEntry[] = [],
    excludedPaths: string[] = [],
    paths: string[] = [],
    riskPaths: Partial<Record<SourceImportRiskCode, string[]>> = {};
  const recordRisk = (code: SourceImportRiskCode, path: string): void => {
    const bucket = (riskPaths[code] ??= []);
    if (bucket.length < 250) bucket.push(path);
  };
  let textTotal = 0;
  let assetTotal = 0;
  for (const entry of value.tree) {
    if (
      !record(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha !== "string" ||
      !SHA.test(entry.sha)
    )
      throw new SourceControlError("invalid_tree");
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const path = prefix ? entry.path.slice(prefix.length) : entry.path;
    assertSourcePath(path);
    if (entry.type === "tree" && entry.mode === "040000") continue;
    paths.push(path);
    if (entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))) {
      if (interactive) {
        excludedPaths.push(path);
        recordRisk("unsupported_files", path);
        continue;
      }
      throw new SourceControlError("unsupported_entry", path);
    }
    if (interactive) {
      const excludedReason = classifyInteractiveExclusion(path);
      if (excludedReason) {
        excludedPaths.push(path);
        recordRisk(excludedReason, path);
        continue;
      }
      if (SKIPPABLE_BINARY_PATTERN.test(path)) {
        excludedPaths.push(path);
        recordRisk("unsupported_files", path);
        continue;
      }
    } else if (shouldExcludeSourcePath(path)) {
      excludedPaths.push(path);
      continue;
    }
    const size = Number(entry.size);
    const isAsset = ASSET_PATTERN.test(path);
    if (!Number.isSafeInteger(entry.size) || size < 0)
      throw new SourceControlError("size_limit", path);
    if (isAsset) {
      if (size > limits.assetFileBytes)
        throw new SourceControlError("size_limit", path, size, limits.assetFileBytes);
      if ((assetTotal += size) > limits.assetBytes)
        throw new SourceControlError("size_limit", path, assetTotal, limits.assetBytes);
    } else {
      if (size > limits.fileBytes)
        throw new SourceControlError("size_limit", path, size, limits.fileBytes);
      if ((textTotal += size) > limits.totalBytes)
        throw new SourceControlError("size_limit", path, textTotal, limits.totalBytes);
    }
    if (entries.length >= limits.files)
      throw new SourceControlError("size_limit", path, entries.length + 1, limits.files);
    entries.push({
      path,
      blobId: entry.sha,
      size,
      executable: entry.mode === "100755",
    });
  }
  assertDistinctSourcePaths(paths);
  if (!entries.length) throw new SourceControlError("invalid_tree");
  return interactive
    ? { entries, excludedPaths, riskPaths }
    : { entries, excludedPaths };
}
