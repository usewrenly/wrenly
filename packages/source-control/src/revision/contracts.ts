/** Immutable passive bytes are separate from model-visible source text. */
export interface SourceAsset {
  sha256: string;
  mediaType: string;
  byteLength: number;
  base64: string;
}
export interface RevisionFile {
  path: string;
  content: string;
  asset?: SourceAsset;
}
/** Default per-project budgets suitable for constrained self-hosted instances. */
export const DEFAULT_REVISION_LIMITS = {
  files: 1000,
  textFileBytes: 2 * 1024 * 1024,
  textBytes: 8 * 1024 * 1024,
  assetFileBytes: 4 * 1024 * 1024,
  assetBytes: 12 * 1024 * 1024,
  serializedBytes: 48 * 1024 * 1024,
} as const;
// Hard ceilings allow instance owners to expand or select Unlimited import limits without rebuilding Wrenly.
export const REVISION_LIMITS = {
  files: 100_000,
  textFileBytes: 64 * 1024 * 1024,
  textBytes: 1024 * 1024 * 1024,
  assetFileBytes: 128 * 1024 * 1024,
  assetBytes: 1024 * 1024 * 1024,
  serializedBytes: 1536 * 1024 * 1024,
} as const;
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'font/woff', 'font/woff2', 'font/ttf', 'font/otf']);
/** Check JSON shape before allocating decoded bytes; callers verify format and content identity too. */
export function isSourceAsset(value: unknown, maxAssetFileBytes: number = REVISION_LIMITS.assetFileBytes): value is SourceAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  return Object.keys(asset).length === 4 && typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256) &&
    typeof asset.mediaType === 'string' && MEDIA_TYPES.has(asset.mediaType) &&
    typeof asset.byteLength === 'number' && Number.isSafeInteger(asset.byteLength) && asset.byteLength > 0 && asset.byteLength <= maxAssetFileBytes &&
    typeof asset.base64 === 'string' && asset.base64.length === 4 * Math.ceil(asset.byteLength / 3) &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64);
}
/** Portable decoding for ZIP export; the authenticated server verifies SHA-256 before saving. */
export function sourceFileBytes(file: RevisionFile): Uint8Array {
  if (!file.asset) return new TextEncoder().encode(file.content);
  if (file.content !== '' || !isSourceAsset(file.asset)) throw new Error('Invalid saved source asset.');
  const raw = atob(file.asset.base64);
  if (raw.length !== file.asset.byteLength || btoa(raw) !== file.asset.base64) throw new Error('Invalid saved source asset bytes.');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
/** One full-revision ceiling across saved builds, previews, exports and publication. */
export function assertRevisionBudget(files: readonly RevisionFile[]): void {
  if (!files.length || files.length > REVISION_LIMITS.files) throw new Error('Source exceeds the build artifact limits (byte limit or file count).');
  let textBytes = 0, assetBytes = 0;
  for (const file of files) {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid saved source file.');
    if (file.asset) {
      if (file.content !== '' || !isSourceAsset(file.asset)) throw new Error('Invalid saved source asset.');
      assetBytes += file.asset.byteLength;
    } else {
      const bytes = new TextEncoder().encode(file.content).length;
      if (bytes > REVISION_LIMITS.textFileBytes) throw new Error('Source exceeds the build artifact limits (byte limit or file count).');
      textBytes += bytes;
    }
  }
  if (textBytes > REVISION_LIMITS.textBytes || assetBytes > REVISION_LIMITS.assetBytes || new TextEncoder().encode(JSON.stringify(files)).length > REVISION_LIMITS.serializedBytes)
    throw new Error('Source exceeds the build artifact limits (byte limit or file count).');
}
