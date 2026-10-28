import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  chmod,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDatabaseKey,
  encryptDatabaseSecret,
  decryptDatabaseSecret,
} from "./database-secrets";
test("database key initialization is private, persistent and safe under concurrent creators", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-database-key-"));
  try {
    const path = join(directory, "private");
    const keys = await Promise.all([
      loadDatabaseKey(path, false),
      loadDatabaseKey(path, false),
    ]);
    expect(keys[0]?.equals(keys[1]!)).toBe(true);
    expect((await stat(join(path, "database-key"))).mode & 0o777).toBe(0o600);
    expect((await loadDatabaseKey(path, true)).equals(keys[0]!)).toBe(true);
    const envelope = encryptDatabaseSecret(
      "fixture-secret-token",
      keys[0]!,
      "connection-a",
    );
    expect(JSON.stringify(envelope)).not.toContain("fixture-secret-token");
    expect(decryptDatabaseSecret(envelope, keys[0]!, "connection-a")).toBe(
      "fixture-secret-token",
    );
    expect(() =>
      decryptDatabaseSecret(envelope, keys[0]!, "connection-b"),
    ).toThrow("cannot be decrypted");
    expect(() =>
      decryptDatabaseSecret(
        { ...envelope, tag: Buffer.alloc(16).toString("base64") },
        keys[0]!,
        "connection-a",
      ),
    ).toThrow("cannot be decrypted");
    expect(() =>
      decryptDatabaseSecret(envelope, Buffer.alloc(32), "connection-a"),
    ).toThrow("cannot be decrypted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("missing keys with saved ciphertext are never regenerated; unsafe keys and symlinks are refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-database-key-"));
  try {
    const missing = join(directory, "missing");
    await expect(loadDatabaseKey(missing, true)).rejects.toThrow("missing");
    await expect(stat(missing)).rejects.toThrow();
    const path = join(directory, "private");
    await loadDatabaseKey(path, false);
    const original = await readFile(join(path, "database-key"));
    await chmod(join(path, "database-key"), 0o644);
    await expect(loadDatabaseKey(path, false)).rejects.toThrow("private");
    expect((await readFile(join(path, "database-key"))).equals(original)).toBe(
      true,
    );
    await chmod(join(path, "database-key"), 0o600);
    await writeFile(join(path, "database-key"), "invalid");
    await expect(loadDatabaseKey(path, false)).rejects.toThrow("invalid");
    await symlink(path, join(directory, "linked"));
    await expect(
      loadDatabaseKey(join(directory, "linked"), false),
    ).rejects.toThrow("symbolic link");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("orphaned backup storage prevents replacement keys after incomplete metadata recovery", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "wrenly-database-key-backup-"),
  );
  try {
    await mkdir(join(directory, "database-backups", crypto.randomUUID()), {
      recursive: true,
      mode: 0o700,
    });
    await expect(
      loadDatabaseKey(join(directory, "database-keys"), false),
    ).rejects.toThrow("backup storage");
    await expect(
      stat(join(directory, "database-keys", "database-key")),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
