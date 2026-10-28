// Real native parsing runs only in the bounded child.
import { expect, test } from "bun:test";
import sharp from "sharp";
import { decodeProfilePicture } from "../../profile/pictures/profile-picture-decoder";
import {
  MAX_PICTURE_INPUT_BYTES,
  MAX_PICTURE_OUTPUT_BYTES,
} from "../../profile/pictures/profile-picture-policy";
test("picture decoder normalizes supported static images and strips source metadata", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const original = await sharp({
      create: { width: 40, height: 80, channels: 3, background: "#345678" },
    })
      .withMetadata({ orientation: 6 })
      .toFormat(format)
      .toBuffer();
    const output = await decodeProfilePicture(
      original,
      new AbortController().signal,
    );
    const info = await sharp(output).metadata();
    expect(info.format).toBe("webp");
    expect(info.width).toBe(256);
    expect(info.height).toBe(256);
    expect(info.exif).toBeUndefined();
    expect(output.byteLength).toBeLessThanOrEqual(MAX_PICTURE_OUTPUT_BYTES);
  }
});
test("decoder rejects empty, oversize, malformed, SVG, animated and excessive-pixel images", async () => {
  const animation = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  const animatedWebp = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
    raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
  })
    .webp()
    .toBuffer();
  expect((await sharp(animatedWebp, { animated: true }).metadata()).pages).toBe(
    2,
  );
  const oversized = await sharp({
    create: { width: 5000, height: 4000, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(MAX_PICTURE_INPUT_BYTES + 1),
    new Uint8Array([1, 2, 3]),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    ),
    animation,
    animatedWebp,
    oversized,
  ]) {
    await expect(
      decodeProfilePicture(bytes, new AbortController().signal),
    ).rejects.toThrow();
  }
});
test("cancelled decoding releases the slot without leaving a process", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    decodeProfilePicture(new Uint8Array([1]), controller.signal),
  ).rejects.toThrow("cancelled");
  const original = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  expect(
    (await decodeProfilePicture(original, new AbortController().signal)).length,
  ).toBeGreaterThan(0);
});

test("an in-flight cancellation rejects competing decoding and frees admission", async () => {
  const original = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#abc" },
  })
    .png()
    .toBuffer();
  const controller = new AbortController();
  const first = decodeProfilePicture(original, controller.signal);
  await expect(
    decodeProfilePicture(original, new AbortController().signal),
  ).rejects.toThrow("Another picture");
  controller.abort();
  await expect(first).rejects.toThrow();
  expect(
    (await decodeProfilePicture(original, new AbortController().signal)).length,
  ).toBeGreaterThan(0);
});

test("standalone decoder exits on its own deadline even if the upload stream stalls", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      new URL(
        "../../profile/pictures/profile-picture-decoder-worker.ts",
        import.meta.url,
      ).pathname,
    ],
    { env: {}, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  );
  let forced = false;
  const failsafe = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, 8000);
  try {
    expect(await child.exited).not.toBe(0);
    expect(forced).toBe(false);
  } finally {
    clearTimeout(failsafe);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10000);
