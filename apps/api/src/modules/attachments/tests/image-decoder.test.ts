import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { decodeAttachmentImage } from "../images/decoder";
import { readAttachmentBytes } from "../images/stream";

describe("reference image normalization", () => {
  test("keeps screenshot proportions and removes metadata without enlarging", async () => {
    const input = await sharp({
      create: { width: 300, height: 100, channels: 3, background: "#ffffff" },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const output = await decodeAttachmentImage(
      input,
      new AbortController().signal,
    );
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(300);
    expect(metadata.height).toBe(100);
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });
  test("fits large screenshots inside the canonical edge without cropping", async () => {
    const input = await sharp({
      create: { width: 5000, height: 1000, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const output = await decodeAttachmentImage(
      input,
      new AbortController().signal,
    );
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(4096);
    expect(metadata.height).toBe(819);
  });
  test("rejects compressed images whose decoded pixels exceed the budget", async () => {
    const input = await sharp({
      create: { width: 4100, height: 4000, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await expect(
      decodeAttachmentImage(input, new AbortController().signal),
    ).rejects.toThrow();
  });
  test("rejects corrupt content even when its JPEG header matches", async () => {
    await expect(
      decodeAttachmentImage(
        new Uint8Array([255, 216, 255, 0]),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  test("rejects cancelled work before starting a decoder", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodeAttachmentImage(new Uint8Array([255, 216, 255]), controller.signal),
    ).rejects.toThrow();
  });
  test("caps actual streamed output independently of headers", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readAttachmentBytes(stream, 4)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
