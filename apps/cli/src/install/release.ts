/** The CLI pins reviewed source bytes; a GitHub checksum is integrity evidence, not a signature. */
import { createHash } from "node:crypto";
// Updated alongside PINNED_RELEASE on each published CLI release.
export const CLI_VERSION = "0.1.0-beta.5";
export interface Release {
  revision: string;
  sha256: string;
}
export const PINNED_RELEASE: Readonly<Release> = Object.freeze({
  revision: "99061ff29631df4a29d8440d046b27a099a1fcf4",
  sha256: "698b652c498779c392e052cb33c774ca4a04f1c45091795312ef6d8f47d62af8",
});
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
export function verifyRelease(bytes: Uint8Array, release: Release): void {
  if (
    !/^[a-f0-9]{40}$/.test(release.revision) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    bytes.length > MAX_ARCHIVE_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== release.sha256
  )
    throw new Error(
      "Source archive verification failed. No release files were executed.",
    );
}
/** Only the official immutable archive URL is accepted; redirects and oversized bodies fail closed. */
export async function downloadRelease(release: Release): Promise<Uint8Array> {
  if (!/^[a-f0-9]{40}$/.test(release.revision))
    throw new Error("Invalid source revision.");
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://codeload.github.com/usewrenly/wrenly/tar.gz/${release.revision}`,
      { redirect: "error", credentials: "omit", signal },
    );
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length") ?? 0) > MAX_ARCHIVE_BYTES
    )
      throw new Error("Archive unavailable.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > MAX_ARCHIVE_BYTES) throw new Error("Archive too large.");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    verifyRelease(bytes, release);
    return bytes;
  } catch {
    throw new Error(
      "Could not download and verify the selected source release. Check your connection or supply the exact verified archive with --archive.",
    );
  }
}
