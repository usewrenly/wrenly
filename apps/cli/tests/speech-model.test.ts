import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildWhisperModelUrl,
  ensureVerifiedSpeechModel,
  loadSpeechModelManifest,
  type SpeechModelFetch,
  type SpeechModelManifest,
} from "../src/install/speech-model";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

async function createManifestFixture(
  directory: string,
  payload: Uint8Array,
): Promise<SpeechModelManifest> {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const manifest: SpeechModelManifest = {
    runtimeVersion: 1,
    whisperRevision: "d1be6fde11ac6e0407606b4e42fe72d34add8037",
    whisperVersion: "1.9.5",
    model: {
      repository: "ggerganov/whisper.cpp",
      revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
      filename: "ggml-base.bin",
      sha256,
      bytes: payload.byteLength,
      license: "MIT",
    },
  };
  const manifestDir = join(
    directory,
    "packages",
    "sandbox",
    "images",
    "transcription",
  );
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, "model-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}

describe("speech model provisioning", () => {
  test("reads the checked-in transcription manifest and builds its HTTPS download URL", async () => {
    const manifest = await loadSpeechModelManifest(REPO_ROOT);
    expect(manifest.model.filename).toBe("ggml-base.bin");
    expect(manifest.model.bytes).toBe(147951465);
    expect(manifest.model.sha256).toBe(
      "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    );
    expect(buildWhisperModelUrl(manifest)).toBe(
      `https://huggingface.co/${manifest.model.repository}/resolve/${manifest.model.revision}/${manifest.model.filename}`,
    );
  });

  test("downloads via HTTPS redirect, verifies SHA-256, and sets 0o700/0o644 permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrenly-speech-valid-"));
    try {
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const manifest = await createManifestFixture(root, payload);
      const expectedUrl = buildWhisperModelUrl(manifest);
      const cdnUrl = "https://cdn-lfs.huggingface.co/repos/ggml-base.bin";
      const requested: string[] = [];

      const mockFetch: SpeechModelFetch = async (input): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        requested.push(url);
        if (url === expectedUrl) {
          return new Response(null, {
            status: 302,
            headers: { location: cdnUrl },
          });
        }
        if (url === cdnUrl) {
          return new Response(payload, {
            status: 200,
            headers: { "content-length": String(payload.byteLength) },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const modelPath = await ensureVerifiedSpeechModel(root, mockFetch);
      expect(modelPath).toBe(join(root, ".wrenly", "speech", "ggml-base.bin"));
      expect(requested).toEqual([expectedUrl, cdnUrl]);
      expect(new Uint8Array(await readFile(modelPath))).toEqual(payload);

      const dirStat = await lstat(join(root, ".wrenly", "speech"));
      const fileStat = await lstat(modelPath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reuses an existing verified model file without downloading again", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrenly-speech-reuse-"));
    try {
      const payload = new Uint8Array([11, 22, 33, 44, 55]);
      await createManifestFixture(root, payload);
      const speechDir = join(root, ".wrenly", "speech");
      const targetPath = join(speechDir, "ggml-base.bin");
      await mkdir(speechDir, { recursive: true, mode: 0o700 });
      await writeFile(targetPath, payload);
      await chmod(targetPath, 0o600);

      const mockFetch: SpeechModelFetch = async (): Promise<Response> => {
        throw new Error("Network download must not run when verified weights already exist");
      };

      const resolved = await ensureVerifiedSpeechModel(root, mockFetch);
      expect(resolved).toBe(targetPath);
      expect((await lstat(targetPath)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects SHA-256 mismatch and leaves no target or temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrenly-speech-hash-"));
    try {
      const expectedPayload = new Uint8Array([1, 2, 3, 4]);
      const tamperedPayload = new Uint8Array([1, 2, 3, 9]);
      await createManifestFixture(root, expectedPayload);

      const mockFetch: SpeechModelFetch = async (): Promise<Response> => {
        return new Response(tamperedPayload, {
          status: 200,
          headers: { "content-length": String(tamperedPayload.byteLength) },
        });
      };

      await expect(ensureVerifiedSpeechModel(root, mockFetch)).rejects.toThrow(
        "SHA-256 verification failed",
      );
      expect(await readdir(join(root, ".wrenly", "speech"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborts oversized streams even when content-length is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrenly-speech-oversize-"));
    try {
      const expectedPayload = new Uint8Array([1, 2, 3, 4]);
      await createManifestFixture(root, expectedPayload);

      const mockFetch: SpeechModelFetch = async (): Promise<Response> => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      };

      await expect(ensureVerifiedSpeechModel(root, mockFetch)).rejects.toThrow(
        "exceeded expected size",
      );
      expect(await readdir(join(root, ".wrenly", "speech"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses non-HTTPS redirects without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrenly-speech-http-"));
    try {
      const expectedPayload = new Uint8Array([1, 2, 3, 4]);
      await createManifestFixture(root, expectedPayload);
      let calls = 0;

      const mockFetch: SpeechModelFetch = async (): Promise<Response> => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "http://insecure.example.com/ggml-base.bin" },
        });
      };

      await expect(ensureVerifiedSpeechModel(root, mockFetch)).rejects.toThrow(
        "non-HTTPS redirect",
      );
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symbolic links at the speech directory or target model file", async () => {
    const root = await mkdtemp(join(tmpdir(), "wrenly-speech-symlink-"));
    try {
      const payload = new Uint8Array([1, 2, 3, 4]);
      await createManifestFixture(root, payload);
      const speechDir = join(root, ".wrenly", "speech");
      await mkdir(speechDir, { recursive: true, mode: 0o700 });
      const outside = join(root, "outside.bin");
      await writeFile(outside, payload);
      await symlink(outside, join(speechDir, "ggml-base.bin"));

      const mockFetch: SpeechModelFetch = async (): Promise<Response> => {
        throw new Error("Download must not proceed when target path is a symlink");
      };

      await expect(ensureVerifiedSpeechModel(root, mockFetch)).rejects.toThrow(
        "symbolic link",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
