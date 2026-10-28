/**
 * Profile-picture limits and bounded upload reading.
 * HTTP upload, isolated decoding and persistence share these ceilings so no layer
 * accepts an image that a later layer cannot safely process. Decoding and identity
 * authorization belong to their callers; this module never trusts Content-Length.
 */
export const MAX_PICTURE_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_PICTURE_OUTPUT_BYTES = 64 * 1024;
export const MAX_PICTURE_INPUT_PIXELS = 16 * 1024 * 1024;
export const PICTURE_SIZE = 256;
export const PICTURE_TIMEOUT_MS = 5000;
export class ProfilePictureError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ProfilePictureError";
  }
}
/** Reads actual streamed bytes with a ceiling, independent of Content-Length. */
export async function readPictureBytes(
  stream: ReadableStream<Uint8Array> | null,
  ceiling = MAX_PICTURE_INPUT_BYTES,
): Promise<Uint8Array> {
  if (!stream)
    throw new ProfilePictureError(400, "Choose a PNG, JPEG or WebP picture.");
  const reader = stream.getReader();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, PICTURE_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > ceiling)
        throw new ProfilePictureError(
          413,
          "Choose a picture smaller than 2 MiB.",
        );
      chunks.push(next.value);
    }
    if (expired)
      throw new ProfilePictureError(
        503,
        "Picture reading timed out. Try again.",
      );
    if (!bytes)
      throw new ProfilePictureError(400, "Choose a nonempty picture.");
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
