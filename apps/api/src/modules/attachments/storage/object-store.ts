/**
 * Private canonical bytes, addressed by generated IDs rather than uploaded filenames.
 * Authorization and durable ownership are callers' responsibilities; this store is never a URL server.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
const OBJECT_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export interface StoredAttachmentObject {
  id: string;
  sha256: string;
  byteLength: number;
}

export interface AttachmentObjectStore {
  write(
    bytes: Uint8Array,
    reservedId?: string,
  ): Promise<StoredAttachmentObject>;
  read(object: StoredAttachmentObject): Promise<Uint8Array>;
  remove(id: string): Promise<void>;
}

/** Requires a private directory with no symlink components; an unsafe existing directory is never repaired silently. */
export async function createAttachmentObjectStore(
  directory: string,
): Promise<AttachmentObjectStore> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new Error(
      "Attachment storage must be a private real directory without symlink components.",
    );
  const path = (id: string): string => {
    if (!OBJECT_ID.test(id))
      throw new Error("Invalid attachment object identity.");
    return join(root, id);
  };
  const verifyRoot = async (): Promise<void> => {
    const current = await lstat(root);
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      !current.isDirectory() ||
      (current.mode & 0o077) !== 0 ||
      (await realpath(root)) !== root
    )
      throw new Error("Attachment storage identity changed.");
  };
  return {
    async write(bytes, reservedId) {
      if (!bytes.length || bytes.length > MAX_OBJECT_BYTES)
        throw new Error("Attachment object exceeds its budget.");
      await verifyRoot();
      const id = reservedId ?? randomUUID();
      const target = path(id);
      const handle = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      let complete = false;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await verifyRoot();
        complete = true;
        return {
          id,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.length,
        };
      } finally {
        await handle.close();
        if (!complete) await unlink(target).catch(() => {});
      }
    },
    async read(object) {
      if (
        !Number.isSafeInteger(object.byteLength) ||
        object.byteLength <= 0 ||
        object.byteLength > MAX_OBJECT_BYTES ||
        !SHA256.test(object.sha256)
      )
        throw new Error("Invalid saved attachment metadata.");
      await verifyRoot();
      const handle = await open(
        path(object.id),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== object.byteLength ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error("Attachment object is not a private regular file.");
        // Allocate from validated metadata, never from a potentially changed file's claimed size.
        const bytes = Buffer.alloc(object.byteLength);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!result.bytesRead)
            throw new Error("Attachment object is incomplete.");
          offset += result.bytesRead;
        }
        const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
        if (
          extra.bytesRead ||
          createHash("sha256").update(bytes).digest("hex") !== object.sha256
        )
          throw new Error(
            "Attachment content no longer matches the saved request.",
          );
        await verifyRoot();
        return bytes;
      } finally {
        await handle.close();
      }
    },
    async remove(id) {
      await verifyRoot();
      try {
        await unlink(path(id));
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    },
  };
}
