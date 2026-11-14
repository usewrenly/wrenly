/** Inspect the entire tar before any extraction; links and special files are never followed. */
import { gunzipSync } from "node:zlib";
const BLOCK_BYTES = 512;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export interface SourceEntry {
  path: string;
  content: Uint8Array;
  executable: boolean;
}
function text(bytes: Uint8Array, start: number, length: number): string {
  const value = Buffer.from(bytes.subarray(start, start + length));
  const end = value.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    end < 0 ? value : value.subarray(0, end),
  );
}
function octal(value: string): number {
  if (!/^[0-7]*$/.test(value.trim()))
    throw new Error("Invalid archive number.");
  const result = parseInt(value.trim() || "0", 8);
  if (!Number.isSafeInteger(result))
    throw new Error("Archive number exceeds bounds.");
  return result;
}
function safePath(path: string, root: string): string {
  if (!path.startsWith(root + "/"))
    throw new Error("Archive root differs from the selected revision.");
  const relative = path.slice(root.length + 1).replace(/\/$/, "");
  if (!relative) return "";
  if (
    relative.length > 1024 ||
    relative.includes("\\") ||
    [...relative].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    ) ||
    relative
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("Unsafe archive path.");
  if (
    relative === ".env" ||
    relative.startsWith(".wrenly") ||
    relative.startsWith(".git/") ||
    relative === ".git" ||
    relative === "apps/web/.env.local"
  )
    throw new Error("Archive contains reserved installation files.");
  return relative;
}
function pax(bytes: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = Buffer.from(bytes).indexOf(32, offset);
    if (space < 0) throw new Error("Invalid archive metadata.");
    const size = Number(Buffer.from(bytes.subarray(offset, space)).toString());
    if (!Number.isInteger(size) || size < 5 || offset + size > bytes.length)
      throw new Error("Invalid archive metadata length.");
    const item = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(space + 1, offset + size - 1),
    );
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("Invalid archive metadata key.");
    const key = item.slice(0, separator);
    if (
      key in fields ||
      !["path", "comment", "mtime", "atime", "ctime"].includes(key)
    )
      throw new Error("Unsupported archive metadata.");
    fields[key] = item.slice(separator + 1);
    offset += size;
  }
  return fields;
}
/** Returns only validated regular files, preserving executable bits but never archive ownership. */
export function inspectArchive(
  compressed: Uint8Array,
  revision: string,
): SourceEntry[] {
  const bytes = gunzipSync(compressed, { maxOutputLength: MAX_SOURCE_BYTES });
  const files: SourceEntry[] = [],
    seen = new Set<string>(),
    directories = new Set<string>();
  let pending: Record<string, string> = {};
  let terminated = false;
  for (let offset = 0; offset + BLOCK_BYTES <= bytes.length;) {
    const header = bytes.subarray(offset, offset + BLOCK_BYTES);
    offset += BLOCK_BYTES;
    if (header.every((value) => value === 0)) {
      terminated = true;
      break;
    }
    const checksum = octal(text(header, 148, 8));
    let sum = 0;
    for (let i = 0; i < BLOCK_BYTES; i++)
      sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (sum !== checksum) throw new Error("Archive header checksum failed.");
    const size = octal(text(header, 124, 12));
    if (size > MAX_FILE_BYTES || offset + size > bytes.length)
      throw new Error("Archive file exceeds bounds.");
    const content = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    if (type === "g" || type === "x") {
      const metadata = pax(content);
      if (type === "x") pending = metadata;
      else if (metadata.path)
        throw new Error("Global archive paths are unsupported.");
      continue;
    }
    if (type !== "0" && type !== "5")
      throw new Error("Archive links and special files are unsupported.");
    const prefix = text(header, 345, 155);
    const path = safePath(
      pending.path ?? `${prefix ? prefix + "/" : ""}${text(header, 0, 100)}`,
      `wrenly-${revision}`,
    );
    pending = {};
    if (!path) continue;
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate archive path.");
    seen.add(key);
    if (seen.size > MAX_ENTRIES) throw new Error("Too many archive entries.");
    for (const parent of path
      .split("/")
      .slice(0, -1)
      .map((_, index) =>
        path
          .split("/")
          .slice(0, index + 1)
          .join("/"),
      ))
      if (
        files.some(
          (file) =>
            file.path.normalize("NFC").toLowerCase() ===
            parent.normalize("NFC").toLowerCase(),
        )
      )
        throw new Error("Archive file/directory collision.");
    if (type === "5") {
      if (size) throw new Error("Directory has file content.");
      directories.add(path);
      continue;
    }
    if (
      directories.has(path) ||
      [...seen].some((other) => other.startsWith(key + "/"))
    )
      throw new Error("Archive file/directory collision.");
    files.push({
      path,
      content,
      executable: Boolean(octal(text(header, 100, 8)) & 0o111),
    });
  }
  if (
    !terminated ||
    Object.keys(pending).length ||
    !files.some((file) => file.path === "package.json") ||
    !files.some((file) => file.path === "bun.lock")
  )
    throw new Error("Incomplete source archive.");
  return files;
}
