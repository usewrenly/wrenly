/** The CLI pins reviewed source bytes; a GitHub checksum is integrity evidence, not a signature. */
import { createHash } from "node:crypto";
export interface Release {
  revision: string;
  sha256: string;
}
export const PINNED_RELEASE: Readonly<Release> = Object.freeze({
  revision: "17b5bc9a1955c4793785428bb4e9e1d5f785ca18",
  sha256: "8f1adbc1db6aa66501bd9b2327d13faef9d9d8403a3b4be4604672d06fe5138c",
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
