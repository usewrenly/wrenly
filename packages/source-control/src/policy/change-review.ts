/**
 * COMPONENT: Saved source change review
 * PURPOSE: Describe only deliberate changes to the source managed by a Wrenly project.
 * INPUTS: Imported baseline files and one explicitly selected saved revision.
 * OUTPUTS: Deterministic additions, updates and deletions; no remote mutation.
 * STEPS: Validate both sets, compare exact text, order paths, refuse workflow edits.
 * EDGE CASES: Files outside the baseline/revision remain outside this change set.
 * ERROR STATES: Unsafe files or Actions workflow changes require correction before review.
 */
import type { SourceFile } from "../contracts/source";
import { validateSourceFiles } from "./import-policy";
export type SourceChange =
  | { kind: "add" | "update"; path: string; content: string }
  | { kind: "delete"; path: string };
/** A review is source data only. Authorization, revision pinning and durable intent belong to the API. */
export function reviewSourceChanges(
  baseline: readonly SourceFile[],
  revision: readonly SourceFile[],
): SourceChange[] {
  const before = new Map(
    validateSourceFiles(baseline).map((file) => [file.path, file]),
  );
  const after = new Map(
    validateSourceFiles(revision).map((file) => [file.path, file]),
  );
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: SourceChange[] = [];
  for (const path of paths) {
    const previous = before.get(path),
      content = after.get(path);
    if (previous?.asset && content?.asset && previous.asset.sha256 === content.asset.sha256) continue;
    if (previous?.asset || content?.asset) throw new Error('Imported binary assets must remain unchanged when pushing this revision.');
    if (previous?.content === content?.content) continue;
    // Contents permission deliberately excludes GitHub Actions workflow modification.
    if (path.toLowerCase().startsWith(".github/workflows/"))
      throw new Error(
        "Workflow changes are not supported. Keep .github/workflows unchanged before reviewing a push.",
      );
    if (content === undefined) changes.push({ kind: "delete", path });
    else
      changes.push({
        kind: previous === undefined ? "add" : "update",
        path,
        content: content.content,
      });
  }
  return changes;
}
/** Limit new branches to a project-specific namespace; never accept a default-branch target. */
export function assertNewSourceBranch(branch: string): void {
  if (
    branch.length > 120 ||
    !/^wrenly\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(branch) ||
    branch.endsWith("/") ||
    branch.includes("//")
  )
    throw new Error(
      "Choose a new branch under wrenly/, using letters, numbers, slashes, hyphens or underscores.",
    );
}
