/** A stable fingerprint of every saved path and byte, not just the migration files. */
import { createHash } from "node:crypto";

/** File order is not meaningful; binary path ordering avoids machine-dependent locale rules. */
export function databaseValidationSourceDigest(
  files: ReadonlyArray<{ path: string; content: string }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      ),
    )
    .digest("hex");
}
