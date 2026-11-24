/**
 * COMPONENT: speech-model
 * PURPOSE: Download and checksum-verify Whisper model weights for local voice dictation.
 * INPUTS: Installation root directory (containing checked-in transcription model-manifest.json) and optional fetch implementation.
 * OUTPUTS: Verified local model file path at `<directory>/.wrenly/speech/<filename>` with 0o644 file / 0o700 directory permissions.
 * STEPS:
 *   1. Read and Zod-validate `packages/sandbox/images/transcription/model-manifest.json`.
 *   2. Reject symlinks along `.wrenly`, `.wrenly/speech`, and the target model file path.
 *   3. If the target file already exists as a regular file with exact byte size and SHA-256 digest, enforce permissions and return it without hitting the network.
 *   4. Otherwise stream from `https://huggingface.co/...` with manual redirect validation (HTTPS only, bounded hops), aborting cleanly if size exceeds `manifest.model.bytes`.
 *   5. Verify final byte length and SHA-256 checksum on an exclusive temp file before `fsync`, `0o644` permissions, and atomic rename.
 * EDGE CASES:
 *   - Pre-existing valid weights: idempotent reuse skips network download.
 *   - Pre-existing corrupt or truncated file: atomically replaced only after new download passes full verification.
 *   - Empty or zero-byte stream chunks: ignored during streaming byte count.
 * ERROR STATES:
 *   - Invalid manifest or unsafe filename/revision/repository → throws contextual Error.
 *   - Symlink at storage directory or target model path → refuses before touching filesystem.
 *   - Non-HTTPS redirect or excessive redirects → aborts without following unsafe URL.
 *   - Stream exceeds `manifest.model.bytes` or mismatches SHA-256 → deletes temp file and throws Error.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const SPEECH_MODEL_FILENAME = "ggml-base.bin";

export type SpeechModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const HUGGINGFACE_BASE_URL = "https://huggingface.co";
const SPEECH_DIRECTORY_MODE = 0o700;
const SPEECH_MODEL_FILE_MODE = 0o644;
const SPEECH_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const MAX_SPEECH_MODEL_BYTES = 512 * 1024 * 1024;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const ManifestSchema = z.object({
  runtimeVersion: z.number().int().positive(),
  whisperRevision: z.string().min(1),
  whisperVersion: z.string().min(1),
  model: z.object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    revision: z.string().regex(/^[0-9a-f]{7,64}$/i),
    filename: z.string().regex(/^[A-Za-z0-9_.-]+\.bin$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    bytes: z.number().int().positive().max(MAX_SPEECH_MODEL_BYTES),
    license: z.string().min(1),
  }),
});

export interface SpeechModelManifest {
  runtimeVersion: number;
  whisperRevision: string;
  whisperVersion: string;
  model: {
    repository: string;
    revision: string;
    filename: string;
    sha256: string;
    bytes: number;
    license: string;
  };
}

/**
 * Loads and validates the pinned transcription Whisper model manifest from the checked-out Wrenly source tree.
 */
export async function loadSpeechModelManifest(
  directory: string,
): Promise<SpeechModelManifest> {
  const manifestPath = join(
    directory,
    "packages",
    "sandbox",
    "images",
    "transcription",
    "model-manifest.json",
  );
  const stat = await lstat(manifestPath).catch((error: unknown) => {
    throw new Error(
      `Speech model manifest not found at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Speech model manifest at ${manifestPath} must be a regular file.`);
  }
  const raw = await readFile(manifestPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `Failed to parse speech model manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const validated = ManifestSchema.parse(parsedJson);
  return {
    ...validated,
    model: {
      ...validated.model,
      sha256: validated.model.sha256.toLowerCase(),
    },
  };
}

/**
 * Builds the pinned HTTPS Hugging Face download URL from a validated Whisper model manifest.
 */
export function buildWhisperModelUrl(manifest: SpeechModelManifest): string {
  const validated = ManifestSchema.parse(manifest);
  const url = new URL(
    `/${validated.model.repository}/resolve/${validated.model.revision}/${validated.model.filename}`,
    HUGGINGFACE_BASE_URL,
  );
  if (url.origin !== HUGGINGFACE_BASE_URL) {
    throw new Error(`Unexpected Whisper model origin: ${url.origin}`);
  }
  return url.href;
}

async function assertNoSymlinkPath(path: string, expectDirectory: boolean): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link at speech storage path: ${path}`);
    }
    if (expectDirectory && !stat.isDirectory()) {
      throw new Error(`Expected directory at speech storage path: ${path}`);
    }
    if (!expectDirectory && !stat.isFile()) {
      throw new Error(`Expected regular file at speech model path: ${path}`);
    }
    return true;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function computeFileSha256(filePath: string): Promise<{ bytes: number; sha256: string }> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      hash.update(buffer);
    });
    stream.once("error", (error: Error) => reject(error));
    stream.once("end", () => {
      resolve({ bytes, sha256: hash.digest("hex") });
    });
  });
}

async function openHttpsResponse(
  initialUrl: string,
  fetchImpl: SpeechModelFetch,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "https:") {
      throw new Error(`Refusing non-HTTPS Whisper model URL: ${parsed.protocol}`);
    }
    const response = await fetchImpl(currentUrl, { redirect: "manual", signal });
    if (REDIRECT_STATUS_CODES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new Error(
          `Whisper model download redirect (${response.status}) lacked a Location header.`,
        );
      }
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== "https:") {
        throw new Error(
          `Refusing non-HTTPS redirect during Whisper model download: ${nextUrl.protocol}`,
        );
      }
      currentUrl = nextUrl.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `Failed to download Whisper model: HTTP ${response.status} ${response.statusText}`.trim(),
      );
    }
    return response;
  }
  throw new Error(
    `Exceeded maximum (${MAX_DOWNLOAD_REDIRECTS}) redirects downloading Whisper model.`,
  );
}

/**
 * Ensures `<directory>/.wrenly/speech/<filename>` exists, matches the pinned manifest size and SHA-256 checksum,
 * and carries safe runtime permissions (`0o700` directory, `0o644` weights file readable inside rootless containers).
 */
export async function ensureVerifiedSpeechModel(
  directory: string,
  fetchImpl: SpeechModelFetch = fetch,
): Promise<string> {
  const manifest = await loadSpeechModelManifest(directory);
  const wrenlyDir = join(directory, ".wrenly");
  const speechDir = join(wrenlyDir, "speech");
  const targetPath = join(speechDir, manifest.model.filename);

  await assertNoSymlinkPath(wrenlyDir, true);
  const speechDirExists = await assertNoSymlinkPath(speechDir, true);
  if (!speechDirExists) {
    await mkdir(speechDir, { recursive: true, mode: SPEECH_DIRECTORY_MODE });
  }
  await chmod(speechDir, SPEECH_DIRECTORY_MODE);

  const targetExists = await assertNoSymlinkPath(targetPath, false);
  if (targetExists) {
    const existing = await computeFileSha256(targetPath);
    if (
      existing.bytes === manifest.model.bytes &&
      existing.sha256 === manifest.model.sha256
    ) {
      await chmod(targetPath, SPEECH_MODEL_FILE_MODE);
      return targetPath;
    }
  }

  const downloadUrl = buildWhisperModelUrl(manifest);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SPEECH_DOWNLOAD_TIMEOUT_MS);
  const tempPath = join(
    speechDir,
    `${manifest.model.filename}.tmp-${process.pid}-${Date.now()}`,
  );
  let moved = false;

  try {
    const response = await openHttpsResponse(downloadUrl, fetchImpl, controller.signal);
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader.trim())) {
      const declaredBytes = Number(contentLengthHeader.trim());
      if (declaredBytes > manifest.model.bytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `Whisper model download size (${declaredBytes} bytes) exceeds expected ${manifest.model.bytes} bytes.`,
        );
      }
      if (declaredBytes !== manifest.model.bytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `Whisper model download size (${declaredBytes} bytes) does not match expected ${manifest.model.bytes} bytes.`,
        );
      }
    }

    if (!response.body) {
      throw new Error("Whisper model download response lacked a readable stream.");
    }

    const handle = await open(tempPath, "wx", SPEECH_MODEL_FILE_MODE);
    try {
      const hasher = createHash("sha256");
      const reader = response.body.getReader();
      let receivedBytes = 0;
      let writePosition = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        receivedBytes += value.byteLength;
        if (receivedBytes > manifest.model.bytes) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `Whisper model download exceeded expected size of ${manifest.model.bytes} bytes.`,
          );
        }

        hasher.update(value);
        let written = 0;
        while (written < value.byteLength) {
          const result = await handle.write(
            value,
            written,
            value.byteLength - written,
            writePosition,
          );
          if (result.bytesWritten <= 0) {
            throw new Error("Failed writing Whisper model chunk to temporary file.");
          }
          written += result.bytesWritten;
          writePosition += result.bytesWritten;
        }
      }

      if (receivedBytes !== manifest.model.bytes) {
        throw new Error(
          `Whisper model download truncated: expected ${manifest.model.bytes} bytes, received ${receivedBytes}.`,
        );
      }

      const actualSha256 = hasher.digest("hex");
      if (actualSha256 !== manifest.model.sha256) {
        throw new Error(
          `Whisper model SHA-256 verification failed: expected ${manifest.model.sha256}, received ${actualSha256}.`,
        );
      }

      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }

    // Re-check target right before rename to defend against late symlink substitution.
    await assertNoSymlinkPath(targetPath, false);
    await chmod(tempPath, SPEECH_MODEL_FILE_MODE);
    await rename(tempPath, targetPath);
    moved = true;
    return targetPath;
  } finally {
    clearTimeout(timeoutId);
    if (!moved) {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
