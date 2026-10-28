/**
 * Bounded image decoder supervisor.
 * One short-lived subprocess per API process normalizes an upload without inherited environment secrets.
 * Deadlines and cancellation terminate and await the child; output is bounded before persistence.
 */
import { fileURLToPath } from "node:url";
import {
  MAX_PICTURE_INPUT_BYTES,
  MAX_PICTURE_OUTPUT_BYTES,
  PICTURE_TIMEOUT_MS,
  ProfilePictureError,
  readPictureBytes,
} from "./profile-picture-policy";
let active = false;
/** Normalizes a bounded upload in a disposable subprocess; caller cancellation never leaves a decoder running. */
export async function decodeProfilePicture(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!bytes.byteLength || bytes.byteLength > MAX_PICTURE_INPUT_BYTES)
    throw new ProfilePictureError(413, "Choose a picture smaller than 2 MiB.");
  if (active)
    throw new ProfilePictureError(
      503,
      "Another picture is being processed. Try again shortly.",
    );
  if (signal.aborted)
    throw new ProfilePictureError(400, "Picture upload was cancelled.");
  active = true;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    child?.kill("SIGKILL");
  };
  try {
    const worker = new URL(
      import.meta.path.endsWith(".ts")
        ? "./profile-picture-decoder-worker.ts"
        : "./profile-picture-decoder-worker.js",
      import.meta.url,
    );
    child = Bun.spawn(
      [process.execPath, "--no-env-file", fileURLToPath(worker)],
      { env: {}, stdin: bytes, stdout: "pipe", stderr: "ignore" },
    );
    timer = setTimeout(stop, PICTURE_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    const output = await readPictureBytes(
      child.stdout as ReadableStream<Uint8Array>,
      MAX_PICTURE_OUTPUT_BYTES,
    );
    const status = await child.exited;
    if (status !== 0 || signal.aborted)
      throw new Error("Decoder rejected picture");
    return output;
  } catch {
    throw new ProfilePictureError(
      400,
      "This picture could not be processed. Choose a static PNG, JPEG or WebP under 2 MiB and 16 megapixels.",
    );
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
    active = false;
  }
}
