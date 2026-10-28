import { expect, test } from "bun:test";
import {
  mkdtemp,
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
  loadProviderKey,
  encryptProviderToken,
  decryptProviderToken,
} from "../../credentials/provider-secrets";
test("provider key initialization is private, persistent and safe under concurrent creators", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-provider-key-"));
  try {
    const path = join(directory, "private");
    const keys = await Promise.all([
      loadProviderKey(path, false),
      loadProviderKey(path, false),
    ]);
    expect(keys[0]?.equals(keys[1]!)).toBe(true);
    expect((await stat(join(path, "provider-key"))).mode & 0o777).toBe(0o600);
    expect((await loadProviderKey(path, true)).equals(keys[0]!)).toBe(true);
    const envelope = encryptProviderToken(
      "fixture-secret-token",
      keys[0]!,
      "connection-a",
    );
    expect(JSON.stringify(envelope)).not.toContain("fixture-secret-token");
    expect(decryptProviderToken(envelope, keys[0]!, "connection-a")).toBe(
      "fixture-secret-token",
    );
    expect(() =>
      decryptProviderToken(envelope, keys[0]!, "connection-b"),
    ).toThrow("cannot be decrypted");
    expect(() =>
      decryptProviderToken(
        { ...envelope, tag: Buffer.alloc(16).toString("base64") },
        keys[0]!,
        "connection-a",
      ),
    ).toThrow("cannot be decrypted");
    expect(() =>
      decryptProviderToken(envelope, Buffer.alloc(32), "connection-a"),
    ).toThrow("cannot be decrypted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("missing keys with saved ciphertext are never regenerated; unsafe keys and symlinks are refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-provider-key-"));
  try {
    const missing = join(directory, "missing");
    await expect(loadProviderKey(missing, true)).rejects.toThrow("missing");
    await expect(stat(missing)).rejects.toThrow();
    const path = join(directory, "private");
    await loadProviderKey(path, false);
    const original = await readFile(join(path, "provider-key"));
    await chmod(join(path, "provider-key"), 0o644);
    await expect(loadProviderKey(path, false)).rejects.toThrow("private");
    expect((await readFile(join(path, "provider-key"))).equals(original)).toBe(
      true,
    );
    await chmod(join(path, "provider-key"), 0o600);
    await writeFile(join(path, "provider-key"), "invalid");
    await expect(loadProviderKey(path, false)).rejects.toThrow("invalid");
    await symlink(path, join(directory, "linked"));
    await expect(
      loadProviderKey(join(directory, "linked"), false),
    ).rejects.toThrow("symbolic link");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
