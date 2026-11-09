/** GitHub response decoding; no network requests, tokens or authorization decisions live here. */
import {
  SourceControlError,
  type SourceRepository,
  type SourceTreeEntry,
} from "../../contracts/source";
import {
  SOURCE_LIMITS,
  assertDistinctSourcePaths,
  assertSourcePath,
  shouldExcludeSourcePath,
} from "../../policy/import-policy";
const MAX_TREE_ENTRIES = 4096; // Bound metadata too, including excluded files and directories.
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
  const repository: SourceRepository = {
    provider: "github",
    id: String(value.id),
    owner: value.owner.login,
    name: value.name,
    private: value.private,
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
): {
  entries: SourceTreeEntry[];
  excludedPaths: string[];
} {
  if (
    !SHA.test(expectedTreeId) ||
    !record(value) ||
    value.sha !== expectedTreeId ||
    value.truncated !== false ||
    !Array.isArray(value.tree) ||
    value.tree.length > MAX_TREE_ENTRIES
  )
    throw new SourceControlError("invalid_tree");
  const entries: SourceTreeEntry[] = [],
    excludedPaths: string[] = [],
    paths: string[] = [];
  let total = 0;
  for (const entry of value.tree) {
    if (
      !record(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha !== "string" ||
      !SHA.test(entry.sha)
    )
      throw new SourceControlError("invalid_tree");
    assertSourcePath(entry.path);
    if (entry.type === "tree" && entry.mode === "040000") continue;
    paths.push(entry.path);
    // Refuse symlinks/submodules even when their names otherwise look excludable.
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(String(entry.mode))
    )
      throw new SourceControlError("unsupported_entry");
    if (shouldExcludeSourcePath(entry.path)) {
      excludedPaths.push(entry.path);
      continue;
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      Number(entry.size) < 0 ||
      Number(entry.size) > SOURCE_LIMITS.fileBytes ||
      (total += Number(entry.size)) > SOURCE_LIMITS.totalBytes ||
      entries.length >= SOURCE_LIMITS.files
    )
      throw new SourceControlError("size_limit");
    entries.push({
      path: entry.path,
      blobId: entry.sha,
      size: Number(entry.size),
      executable: entry.mode === "100755",
    });
  }
  assertDistinctSourcePaths(paths);
  if (!entries.length) throw new SourceControlError("invalid_tree");
  return { entries, excludedPaths };
}
