/** Minimal trusted tar writer for archive-policy tests; no shell extraction is used. */
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Release } from "../src/install/release";
export const REVISION = "a".repeat(40);
export function tarFixture(
  extra: Array<{ path: string; type?: string; body?: string }> = [],
): { bytes: Uint8Array; release: Release } {
  const items = [
    { path: `wrenly-${REVISION}/package.json`, body: '{"name":"fixture"}' },
    { path: `wrenly-${REVISION}/bun.lock`, body: "fixture" },
    { path: `wrenly-${REVISION}/apps/web/package.json`, body: "{}" },
    ...extra,
  ];
  const chunks: Buffer[] = [];
  for (const item of items) {
    const header = Buffer.alloc(512),
      body = Buffer.from(item.body ?? "");
    header.write(item.path, 0, 100, "utf8");
    header.write("0000600\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = (item.type ?? "0").charCodeAt(0);
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(chunks));
  return {
    bytes,
    release: {
      revision: REVISION,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
