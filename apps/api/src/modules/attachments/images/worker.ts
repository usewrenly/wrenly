/** Native image parsing runs in a disposable process, never in the HTTP listener. */
import sharp from "sharp";
import { ATTACHMENT_LIMITS, detectAttachmentImage } from "@wrenly/inference";
import { readAttachmentBytes } from "./stream";
import {
  ATTACHMENT_DECODE_TIMEOUT_MS,
  MAX_CANONICAL_IMAGE_BYTES,
  CANONICAL_IMAGE_QUALITY,
} from "./limits";

const deadline = setTimeout(
  () => process.exit(1),
  ATTACHMENT_DECODE_TIMEOUT_MS,
);
try {
  sharp.cache(false);
  sharp.concurrency(1);
  const bytes = await readAttachmentBytes(
    Bun.stdin.stream(),
    ATTACHMENT_LIMITS.imageBytes,
  );
  const format = detectAttachmentImage(bytes);
  // Some decoders expose only the first APNG frame, so reject the animation chunk directly.
  if (format === "image/png") {
    const input = Buffer.from(bytes);
    let offset = 8;
    while (offset + 12 <= input.length) {
      const length = input.readUInt32BE(offset);
      if (length > input.length - offset - 12)
        throw new Error("Malformed PNG.");
      if (input.subarray(offset + 4, offset + 8).toString() === "acTL")
        throw new Error("Animated PNG.");
      offset += length + 12;
    }
  }
  const image = sharp(bytes, {
    limitInputPixels: ATTACHMENT_LIMITS.decodedPixels,
    failOn: "warning",
    animated: true,
  });
  const metadata = await image.metadata();
  if (
    !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error("Unsupported or animated image.");
  const output = await image
    .rotate()
    .resize({
      width: ATTACHMENT_LIMITS.canonicalImageEdge,
      height: ATTACHMENT_LIMITS.canonicalImageEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: CANONICAL_IMAGE_QUALITY })
    .toBuffer();
  if (!output.length || output.length > MAX_CANONICAL_IMAGE_BYTES)
    throw new Error("Canonical image exceeds limit.");
  await Bun.write(Bun.stdout, output);
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
