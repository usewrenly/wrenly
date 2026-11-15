/**
 * COMPONENT: Imported text source policy
 * PURPOSE: Bound a remote source selection before any generated-code validation.
 * INPUTS: Repository-relative paths and decoded text files.
 * OUTPUTS: A validated source list or a fixed, credential-free failure.
 * STEPS: Reject unsafe paths, exclude private/generated configuration, enforce unique paths and byte limits.
 * EDGE CASES: Unicode/case collisions, file/directory collisions and binary/LFS placeholders.
 * ERROR STATES: Reject unsupported content; never execute hooks, install packages or read host files.
 */
import { SourceControlError, type SourceFile } from "../contracts/source";
export const SOURCE_LIMITS = {
  files: 256,
  pathCharacters: 512,
  fileBytes: 512 * 1024,
  totalBytes: 8 * 1024 * 1024,
} as const;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".ssh",
  ".local",
  "node_modules",
  "vendor",
  ".next",
]);
const PRIVATE_FILE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pypirc|auth\.json|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
/** Validate before joining or decoding; the provider's path is never a host path. */
export function assertSourcePath(path: string): void {
  if (
    !path ||
    path.length > SOURCE_LIMITS.pathCharacters ||
    path !== path.normalize("NFC") ||
    /[\\\x00-\x1f\x7f:#?%]/.test(path) ||
    path.split("/").some((part) =>
      !part || part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new SourceControlError("unsafe_path");
}
/** Exclusions are explicit so callers can report skipped files without importing their contents. */
export function shouldExcludeSourcePath(path: string): boolean {
  assertSourcePath(path);
  const parts = path.split("/");
  const file = parts.at(-1)!;
  // Templates are useful setup instructions, but real environment files never enter the snapshot.
  const template = /^\.env\.(?:example|sample|template)$/i.test(file);
  return (
    parts
      .slice(0, -1)
      .some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase())) ||
    (PRIVATE_FILE.test(file) && !template)
  );
}
/** Reject ambiguous names even on a case-sensitive host so exports remain portable. */
export function assertDistinctSourcePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    assertSourcePath(path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new SourceControlError("unsafe_path");
    seen.add(key);
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join("/")))
        throw new SourceControlError("unsafe_path");
  }
}
/** This validates text only, not whether an app is safe, supported or successfully built. */
export function validateSourceFiles(
  files: readonly SourceFile[],
): SourceFile[] {
  if (!files.length || files.length > SOURCE_LIMITS.files)
    throw new SourceControlError("size_limit");
  assertDistinctSourcePaths(files.map((file) => file.path));
  let total = 0;
  return files.map((file) => {
    if (shouldExcludeSourcePath(file.path))
      throw new SourceControlError("unsafe_path");
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (
      bytes > SOURCE_LIMITS.fileBytes ||
      (total += bytes) > SOURCE_LIMITS.totalBytes
    )
      throw new SourceControlError("size_limit");
    if (
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.content) ||
      file.content.startsWith("version https://git-lfs.github.com/spec/v1") ||
      Buffer.from(file.content, "utf8").toString("utf8") !== file.content
    )
      throw new SourceControlError("invalid_content");
    return { path: file.path, content: file.content };
  });
}
