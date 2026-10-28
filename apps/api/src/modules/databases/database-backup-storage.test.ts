import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  sealDatabaseBackup,
  openDatabaseBackup,
} from "./database-backup-storage";
test("sealed PostgreSQL archive is private, bound, tamper-evident and never overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-backup-test-"));
  const context = {
      resourceId: crypto.randomUUID(),
      backupId: crypto.randomUUID(),
      schemaDigest: "a".repeat(64),
    },
    key = randomBytes(32),
    archive = Buffer.from("PGDMP-private-row-fixture");
  try {
    const saved = await sealDatabaseBackup(directory, key, context, archive),
      path = join(directory, saved.encryptedPath);
    const ciphertext = await readFile(path);
    expect(ciphertext.includes(Buffer.from("private-row-fixture"))).toBe(false);
    expect(
      Buffer.from(
        await openDatabaseBackup(directory, key, context, saved.sha256),
      ),
    ).toEqual(archive);
    await expect(
      sealDatabaseBackup(directory, key, context, archive),
    ).rejects.toThrow();
    await expect(
      openDatabaseBackup(directory, randomBytes(32), context, saved.sha256),
    ).rejects.toThrow();
    await expect(
      openDatabaseBackup(
        directory,
        key,
        { ...context, schemaDigest: "b".repeat(64) },
        saved.sha256,
      ),
    ).rejects.toThrow();
    ciphertext[ciphertext.length - 1] =
      (ciphertext[ciphertext.length - 1] ?? 0) ^ 1;
    await writeFile(path, ciphertext);
    await expect(
      openDatabaseBackup(directory, key, context, saved.sha256),
    ).rejects.toThrow();
    await expect(
      openDatabaseBackup(
        directory,
        key,
        context,
        createHash("sha256").update(ciphertext).digest("hex"),
      ),
    ).rejects.toThrow();
    const other = { ...context, backupId: crypto.randomUUID() };
    await symlink(
      path,
      join(
        directory,
        "database-backups",
        context.resourceId,
        `${other.backupId}.wdb`,
      ),
    );
    await expect(
      openDatabaseBackup(directory, key, other, saved.sha256),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
