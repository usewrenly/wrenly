/** Actual bytes, rather than a supplied Content-Length, determine whether an upload fits. */
export async function readAttachmentBytes(
  stream: ReadableStream<Uint8Array>,
  ceiling: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > ceiling)
        throw new Error("Attachment exceeds its byte budget.");
      chunks.push(next.value);
    }
    if (!length) throw new Error("Attachment is empty.");
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
