/** Sanitizes reference images without cropping; cancellation always terminates the native worker. */
import { fileURLToPath } from "node:url";
import {
  detectAttachmentImage,
  AttachmentPolicyError,
} from "@wrenly/inference";
import { readAttachmentBytes } from "./stream";
import {
  ATTACHMENT_DECODE_TIMEOUT_MS,
  MAX_CANONICAL_IMAGE_BYTES,
} from "./limits";

let active = false;
export async function decodeAttachmentImage(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  detectAttachmentImage(bytes);
  if (active)
    throw new AttachmentPolicyError(
      "Another image is being processed. Try again shortly.",
    );
  signal.throwIfAborted();
  active = true;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    child?.kill("SIGKILL");
  };
  try {
    const worker = new URL(
      import.meta.path.endsWith(".ts")
        ? "./worker.ts"
        : "./attachment-image-worker.js",
      import.meta.url,
    );
    child = Bun.spawn(
      [process.execPath, "--no-env-file", fileURLToPath(worker)],
      {
        env: {},
        stdin: bytes,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    timer = setTimeout(stop, ATTACHMENT_DECODE_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const output = await readAttachmentBytes(
      child.stdout as ReadableStream<Uint8Array>,
      MAX_CANONICAL_IMAGE_BYTES,
    );
    const status = await child.exited;
    if (status !== 0 || signal.aborted)
      throw new Error("Image decoding failed.");
    return output;
  } catch {
    throw new AttachmentPolicyError(
      "This image could not be processed. Choose a static JPEG, PNG or WebP under 5 MiB and 16 megapixels.",
    );
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
    active = false;
  }
}
