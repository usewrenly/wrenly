// Sealed backup archives stay encrypted on the host; plaintext exists only inside isolated helpers.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024;
const TAG_BYTES = 16;
const Context = z
  .object({
    resourceId: z.string().uuid(),
    backupId: z.string().uuid(),
    schemaDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export type DatabaseBackupContext = z.infer<typeof Context>;
const Header = Context.extend({
  version: z.literal(1),
  nonce: z.string().regex(/^[a-f0-9]{24}$/),
}).strict();
function keyFor(key: Buffer, context: DatabaseBackupContext): Buffer {
  if (key.byteLength !== 32) throw new Error("Invalid instance database key");
  return Buffer.from(
    hkdfSync(
      "sha256",
      key,
      context.resourceId,
      `wrenly-backup-v1:${context.backupId}`,
      32,
    ),
  );
}
async function privateDirectory(
  root: string,
  resourceId: string,
): Promise<string> {
  const parent = join(root, "database-backups"),
    directory = join(parent, resourceId);
  for (const path of [root, parent, directory]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error(
        "Backup storage must be private and owned by the API user",
      );
  }
  return directory;
}
/** Authenticated context prevents moving a ciphertext to another resource, revision or backup. */
export async function sealDatabaseBackup(
  root: string,
  key: Buffer,
  input: DatabaseBackupContext,
  archive: Uint8Array,
): Promise<{ encryptedPath: string; sha256: string }> {
  const context = Context.parse(input);
  if (
    !archive.byteLength ||
    archive.byteLength > MAX_ARCHIVE_BYTES ||
    Buffer.from(archive.subarray(0, 5)).toString() !== "PGDMP"
  )
    throw new Error("Invalid bounded PostgreSQL custom archive");
  const directory = await privateDirectory(root, context.resourceId);
  const nonce = randomBytes(12),
    header = Buffer.from(
      JSON.stringify({ ...context, version: 1, nonce: nonce.toString("hex") }),
    );
  const cipher = createCipheriv("aes-256-gcm", keyFor(key, context), nonce);
  cipher.setAAD(header);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.byteLength);
  const bytes = Buffer.concat([
    size,
    header,
    cipher.update(archive),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const target = join(directory, `${context.backupId}.wdb`),
    temporary = join(
      directory,
      `${context.backupId}.${randomBytes(8).toString("hex")}.partial`,
    );
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await link(temporary, target);
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return {
      encryptedPath: `database-backups/${context.resourceId}/${context.backupId}.wdb`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
/** Verifies file ownership, ciphertext digest and authentication before exposing archive bytes to a restore helper. */
export async function openDatabaseBackup(
  root: string,
  key: Buffer,
  input: DatabaseBackupContext,
  expectedDigest: string,
): Promise<Uint8Array> {
  const context = Context.parse(input);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest))
    throw new Error("Invalid backup digest");
  const directory = await privateDirectory(root, context.resourceId);
  const file = await open(
    join(directory, `${context.backupId}.wdb`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      info.size > MAX_ARCHIVE_BYTES + MAX_HEADER_BYTES + TAG_BYTES + 4 ||
      info.size < 32
    )
      throw new Error("Invalid private backup file");
    const bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest)
      throw new Error("Backup digest changed");
    const headerLength = bytes.readUInt32BE();
    if (
      headerLength > MAX_HEADER_BYTES ||
      headerLength < 1 ||
      headerLength + 4 + TAG_BYTES >= bytes.byteLength
    )
      throw new Error("Invalid backup header");
    const headerBytes = bytes.subarray(4, 4 + headerLength),
      header = Header.parse(JSON.parse(headerBytes.toString()) as unknown);
    if (
      header.resourceId !== context.resourceId ||
      header.backupId !== context.backupId ||
      header.schemaDigest !== context.schemaDigest
    )
      throw new Error("Backup context changed");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFor(key, context),
      Buffer.from(header.nonce, "hex"),
    );
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    const archive = Buffer.concat([
      decipher.update(bytes.subarray(4 + headerLength, -TAG_BYTES)),
      decipher.final(),
    ]);
    if (archive.subarray(0, 5).toString() !== "PGDMP")
      throw new Error("Invalid backup archive");
    return archive;
  } finally {
    await file.close();
  }
}
