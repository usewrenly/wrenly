import { DEFAULT_REVISION_LIMITS, REVISION_LIMITS } from "../revision/contracts";
import { materializeSourceFile } from "../revision/assets";
/**
 * COMPONENT: Imported text source policy
 * PURPOSE: Bound a remote source selection before any generated-code validation.
 * INPUTS: Repository-relative paths and decoded text files.
 * OUTPUTS: A validated source list or a fixed, credential-free failure.
 * STEPS: Reject unsafe paths, exclude private/generated configuration, enforce unique paths and byte limits.
 * EDGE CASES: Unicode/case collisions, file/directory collisions and binary/LFS placeholders.
 * ERROR STATES: Reject unsupported content; never execute hooks, install packages or read host files.
 */
import { SourceControlError, type SourceFile, type SourceImportRiskCode } from "../contracts/source";
export const SOURCE_LIMITS = {
  files: DEFAULT_REVISION_LIMITS.files,
  pathCharacters: 512,
  fileBytes: DEFAULT_REVISION_LIMITS.textFileBytes,
  totalBytes: DEFAULT_REVISION_LIMITS.textBytes,
} as const;
export interface SourceImportLimits {
  files: number;
  fileBytes: number;
  totalBytes: number;
  assetFileBytes: number;
  assetBytes: number;
}
export const DEFAULT_IMPORT_LIMITS: SourceImportLimits = {
  ...SOURCE_LIMITS,
  assetFileBytes: DEFAULT_REVISION_LIMITS.assetFileBytes,
  assetBytes: DEFAULT_REVISION_LIMITS.assetBytes,
};
export type ImportLimitPresetId = "default" | "medium" | "large" | "unlimited";
export const IMPORT_LIMIT_PRESETS: Record<
  ImportLimitPresetId,
  {
    id: ImportLimitPresetId;
    label: string;
    description: string;
    limits: SourceImportLimits;
  }
> = {
  default: {
    id: "default",
    label: "Standard (8 MB)",
    description: "1,000 files · 8 MB source · 12 MB assets (Recommended for 2 GB hosts)",
    limits: { ...DEFAULT_IMPORT_LIMITS },
  },
  medium: {
    id: "medium",
    label: "Expanded (32 MB)",
    description: "3,000 files · 32 MB source · 48 MB assets",
    limits: {
      files: 3000,
      fileBytes: 8 * 1024 * 1024,
      totalBytes: 32 * 1024 * 1024,
      assetFileBytes: 16 * 1024 * 1024,
      assetBytes: 48 * 1024 * 1024,
    },
  },
  large: {
    id: "large",
    label: "Large (128 MB)",
    description: "10,000 files · 128 MB source · 128 MB assets",
    limits: {
      files: 10000,
      fileBytes: 16 * 1024 * 1024,
      totalBytes: 128 * 1024 * 1024,
      assetFileBytes: 32 * 1024 * 1024,
      assetBytes: 128 * 1024 * 1024,
    },
  },
  unlimited: {
    id: "unlimited",
    label: "Unlimited",
    description: "Up to 100,000 files · 1 GB source · 1 GB assets (Bound only by host capacity)",
    limits: {
      files: REVISION_LIMITS.files,
      fileBytes: REVISION_LIMITS.textFileBytes,
      totalBytes: REVISION_LIMITS.textBytes,
      assetFileBytes: REVISION_LIMITS.assetFileBytes,
      assetBytes: REVISION_LIMITS.assetBytes,
    },
  },
};

export function resolveImportLimitsPreset(preset: ImportLimitPresetId): SourceImportLimits {
  return { ...IMPORT_LIMIT_PRESETS[preset].limits };
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".ssh",
  ".local",
  "node_modules",
  "vendor",
  ".next",
]);
const CACHE_DIRECTORIES = new Set([
  ".next",
  ".turbo",
  "storage",
  "bootstrap/cache",
]);
const PRIVATE_FILE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pypirc|auth\.json|composer\.phar|bunfig\.toml|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;

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

/** Classifies files/directories that should be excluded or flagged during interactive repository review. */
export function classifyInteractiveExclusion(path: string): SourceImportRiskCode | null {
  assertSourcePath(path);
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const file = parts.at(-1)!;
  if (parts.slice(0, -1).some((part) => part === "node_modules" || part === "vendor"))
    return "installed_dependencies";
  if (
    lower.startsWith("bootstrap/cache/") ||
    lower.startsWith("storage/") ||
    parts.slice(0, -1).some((part) => CACHE_DIRECTORIES.has(part))
  )
    return "runtime_caches";
  if (parts.slice(0, -1).some((part) => [".git", ".ssh", ".local"].includes(part)))
    return "private_env";
  const template = /^\.env\.(?:example|sample|template)$/i.test(file);
  if (PRIVATE_FILE.test(file) && !template)
    return "private_env";
  return null;
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
  limits: SourceImportLimits = DEFAULT_IMPORT_LIMITS,
): SourceFile[] {
  if (!files.length || files.length > limits.files)
    throw new SourceControlError("size_limit");
  assertDistinctSourcePaths(files.map((file) => file.path));
  let total = 0;
  let assetTotal = 0;
  return files.map((file) => {
    if (shouldExcludeSourcePath(file.path))
      throw new SourceControlError("unsafe_path");
    if (file.asset) {
      try { materializeSourceFile(file); } catch { throw new SourceControlError("invalid_content"); }
      if (file.asset.byteLength > limits.assetFileBytes) throw new SourceControlError("size_limit", file.path, file.asset.byteLength, limits.assetFileBytes);
      if ((assetTotal += file.asset.byteLength) > limits.assetBytes) throw new SourceControlError("size_limit", file.path, assetTotal, limits.assetBytes);
      return { path: file.path, content: "", asset: { ...file.asset } };
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > limits.fileBytes)
      throw new SourceControlError("size_limit", file.path, bytes, limits.fileBytes);
    if ((total += bytes) > limits.totalBytes)
      throw new SourceControlError("size_limit", file.path, total, limits.totalBytes);
    if (
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.content) ||
      file.content.startsWith("version https://git-lfs.github.com/spec/v1") ||
      Buffer.from(file.content, "utf8").toString("utf8") !== file.content
    )
      throw new SourceControlError("invalid_content", file.path);
    return { path: file.path, content: file.content };
  });
}
