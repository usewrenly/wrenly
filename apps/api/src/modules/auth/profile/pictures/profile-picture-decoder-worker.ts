/**
 * Isolated image normalization worker.
 * Only this short-lived process loads native image parsing.
 * Reads bounded stdin, rejects unsupported/animated input, limits pixels and emits a metadata-free canonical WebP on stdout.
 * Source and bundled supervisors resolve the adjacent worker entry.
 */
import sharp from "sharp";
import {
  MAX_PICTURE_INPUT_PIXELS,
  MAX_PICTURE_OUTPUT_BYTES,
  PICTURE_SIZE,
  PICTURE_TIMEOUT_MS,
  readPictureBytes,
} from "./profile-picture-policy";
const deadline = setTimeout(() => process.exit(1), PICTURE_TIMEOUT_MS);
try {
  sharp.cache(false);
  sharp.concurrency(1);
  const bytes = await readPictureBytes(Bun.stdin.stream());
  const signature = Buffer.from(bytes);
  const supported =
    signature
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) ||
    (signature.subarray(0, 4).toString() === "RIFF" &&
      signature.subarray(8, 12).toString() === "WEBP");
  if (!supported) throw new Error("Unsupported image signature");
  // libvips can expose only the first APNG frame; reject its animation chunk before decoding.
  if (signature[0] === 137) {
    let offset = 8;
    while (offset + 12 <= signature.length) {
      const length = signature.readUInt32BE(offset);
      if (signature.subarray(offset + 4, offset + 8).toString() === "acTL")
        throw new Error("Animated PNG");
      if (length > signature.length - offset - 12)
        throw new Error("Malformed PNG");
      offset += length + 12;
    }
  }
  const image = sharp(bytes, {
    limitInputPixels: MAX_PICTURE_INPUT_PIXELS,
    failOn: "warning",
    animated: true,
  });
  const metadata = await image.metadata();
  if (
    !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error("Unsupported image");
  const output = await image
    .rotate()
    .resize(PICTURE_SIZE, PICTURE_SIZE, { fit: "cover" })
    .webp({ quality: 80 })
    .toBuffer();
  if (!output.byteLength || output.byteLength > MAX_PICTURE_OUTPUT_BYTES)
    throw new Error("Output too large");
  await Bun.write(Bun.stdout, output);
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
