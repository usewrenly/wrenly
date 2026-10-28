// Writes standard uncompressed ZIP records locally; saved text is never executed.
// Header offsets below follow the ZIP format; a fixed DOS epoch avoids local-time variation.
export const MAX_SOURCE_FILES = 1000;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;
const UTF8_FLAG = 0x0800;
const DOS_EPOCH_DATE = 0x0021;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pathBytes(path: string): Uint8Array {
  const bytes = encoder.encode(path);
  if (
    !path ||
    bytes.length > MAX_PATH_BYTES ||
    decoder.decode(bytes) !== path ||
    /[\u0000-\u001f\u007f\\<>:"|?*]/u.test(path) ||
    path.startsWith("/")
  )
    throw new Error("This revision contains an unsupported source path.");
  for (const segment of path.split("/")) {
    if (
      !segment ||
      encoder.encode(segment).length > MAX_SEGMENT_BYTES ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
      throw new Error(
        "This revision contains an unsafe or platform-reserved source path.",
      );
  }
  return bytes;
}
/** Archives exact saved text files; rejects ambiguous paths and limits before allocating the ZIP. */
export function createSourceZip(
  files: ReadonlyArray<{ path: string; content: string }>,
): Uint8Array<ArrayBuffer> {
  if (!files.length || files.length > MAX_SOURCE_FILES)
    throw new Error(
      `Source download supports 1–${MAX_SOURCE_FILES} saved files.`,
    );
  const identities = new Set<string>();
  let sourceBytes = 0;
  const entries = files.map((file) => {
    const name = pathBytes(file.path);
    const identity = file.path.normalize("NFC").toLowerCase();
    if (identities.has(identity))
      throw new Error("This revision contains conflicting source paths.");
    identities.add(identity);
    // UTF-8 is never smaller than this safe lower bound; reject large inputs before encoding.
    if (file.content.length > MAX_SOURCE_BYTES - sourceBytes)
      throw new Error("Source download is limited to 20 MiB.");
    const content = encoder.encode(file.content);
    if (decoder.decode(content) !== file.content)
      throw new Error(
        "This revision contains text that cannot be preserved as UTF-8.",
      );
    sourceBytes += content.length;
    if (sourceBytes > MAX_SOURCE_BYTES)
      throw new Error("Source download is limited to 20 MiB.");
    return { name, content, crc: crc32(content) };
  });
  for (const identity of identities) {
    const segments = identity.split("/");
    for (let index = 1; index < segments.length; index++)
      if (identities.has(segments.slice(0, index).join("/")))
        throw new Error(
          "This revision has a file where an archive directory is required.",
        );
  }
  const localBytes = entries.reduce(
    (sum, entry) =>
      sum + LOCAL_HEADER_BYTES + entry.name.length + entry.content.length,
    0,
  );
  const centralBytes = entries.reduce(
    (sum, entry) => sum + CENTRAL_HEADER_BYTES + entry.name.length,
    0,
  );
  const output = new Uint8Array(localBytes + centralBytes + END_RECORD_BYTES);
  const view = new DataView(output.buffer);
  let local = 0;
  let central = localBytes;
  for (const entry of entries) {
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint16(local + 6, UTF8_FLAG, true);
    view.setUint16(local + 12, DOS_EPOCH_DATE, true);
    view.setUint32(local + 14, entry.crc, true);
    view.setUint32(local + 18, entry.content.length, true);
    view.setUint32(local + 22, entry.content.length, true);
    view.setUint16(local + 26, entry.name.length, true);
    output.set(entry.name, local + LOCAL_HEADER_BYTES);
    output.set(entry.content, local + LOCAL_HEADER_BYTES + entry.name.length);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, UTF8_FLAG, true);
    view.setUint16(central + 14, DOS_EPOCH_DATE, true);
    view.setUint32(central + 16, entry.crc, true);
    view.setUint32(central + 20, entry.content.length, true);
    view.setUint32(central + 24, entry.content.length, true);
    view.setUint16(central + 28, entry.name.length, true);
    view.setUint32(central + 42, local, true);
    output.set(entry.name, central + CENTRAL_HEADER_BYTES);
    local += LOCAL_HEADER_BYTES + entry.name.length + entry.content.length;
    central += CENTRAL_HEADER_BYTES + entry.name.length;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, entries.length, true);
  view.setUint16(central + 10, entries.length, true);
  view.setUint32(central + 12, centralBytes, true);
  view.setUint32(central + 16, localBytes, true);
  return output;
}
