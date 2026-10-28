/**
 * Instance-local provider credential encryption.
 * Maintains a private persistent key independent of auth signing, with no-follow file access and atomic creation.
 * Existing ciphertext forbids silent key regeneration; authenticated envelopes bind tokens to one connection.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 8192;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ALGORITHM = "aes-256-gcm";
const Envelope = z
  .object({
    version: z.literal(1),
    keyId: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().max(32),
    tag: z.string().max(32),
    ciphertext: z.string().max(12_000),
  })
  .strict();
export type ProviderSecretEnvelope = z.infer<typeof Envelope>;
export class ProviderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderKeyError";
  }
}
const keyId = (key: Buffer): string =>
  createHash("sha256").update(key).digest("hex");
function checkPermissions(mode: number, uid: number): void {
  if (
    (mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && uid !== process.getuid())
  )
    throw new ProviderKeyError(
      "Provider key storage must be private and owned by the API process user.",
    );
}
async function readKey(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    checkPermissions(stat.mode, stat.uid);
    if (!stat.isFile() || stat.size !== KEY_BYTES)
      throw new ProviderKeyError(
        "Provider encryption key is invalid. Restore the original key from your instance backup.",
      );
    return await file.readFile();
  } finally {
    await file.close();
  }
}
/** Creates a private key only before any encrypted credentials exist; concurrent creation cannot overwrite it. */
export async function loadProviderKey(
  dataDirectory: string,
  encryptedCredentialsExist: boolean,
): Promise<Buffer> {
  let temporary: string | undefined;
  try {
    const directory = resolve(dataDirectory),
      path = join(directory, "provider-key");
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ProviderKeyError(
          "Provider key directory must be a private directory, not a symbolic link.",
        );
      checkPermissions(stat.mode, stat.uid);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      if (encryptedCredentialsExist)
        throw new ProviderKeyError(
          "Provider encryption key is missing. Restore the original instance data directory; saved tokens cannot be recovered with a new key.",
        );
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      const stat = await lstat(directory);
      checkPermissions(stat.mode, stat.uid);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ProviderKeyError("Provider key storage is unsafe.");
    }
    try {
      return await readKey(path);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      if (encryptedCredentialsExist)
        throw new ProviderKeyError(
          "Provider encryption key is missing. Restore it from the instance backup; a replacement cannot decrypt saved tokens.",
        );
    }
    temporary = join(
      directory,
      `.provider-key-${randomBytes(16).toString("hex")}`,
    );
    const file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      FILE_MODE,
    );
    try {
      await file.writeFile(randomBytes(KEY_BYTES));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    return await readKey(path);
  } catch (error) {
    if (error instanceof ProviderKeyError) throw error;
    throw new ProviderKeyError(
      "Provider encryption key storage is unavailable. Check its private directory permissions and persistent volume.",
    );
  } finally {
    if (temporary) {
      try {
        await unlink(temporary);
      } catch {
        /* A private temporary file is never used as a replacement key. */
      }
    }
  }
}
function decoded(value: string, bytes?: number): Buffer {
  const buffer = Buffer.from(value, "base64");
  if (
    buffer.toString("base64") !== value ||
    !buffer.length ||
    (bytes !== undefined && buffer.length !== bytes) ||
    buffer.length > MAX_TOKEN_BYTES
  )
    throw new Error("Invalid encoding");
  return buffer;
}
/** Encrypts a token for one immutable connection; no plaintext enters stored metadata. */
export function encryptProviderToken(
  token: string,
  key: Buffer,
  connectionId: string,
): ProviderSecretEnvelope {
  if (
    key.length !== KEY_BYTES ||
    !token ||
    Buffer.byteLength(token) > MAX_TOKEN_BYTES
  )
    throw new ProviderKeyError(
      "Provider token is empty or exceeds its size limit.",
    );
  const nonce = randomBytes(NONCE_BYTES),
    cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(`provider-credential:v1:${connectionId}`));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    keyId: keyId(key),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
/** Authenticates the key, ciphertext and connection binding before decrypting server-side. */
export function decryptProviderToken(
  raw: unknown,
  key: Buffer,
  connectionId: string,
): string {
  try {
    const envelope = Envelope.parse(raw);
    if (key.length !== KEY_BYTES || envelope.keyId !== keyId(key))
      throw new Error("Key mismatch");
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      decoded(envelope.nonce, NONCE_BYTES),
    );
    decipher.setAAD(Buffer.from(`provider-credential:v1:${connectionId}`));
    decipher.setAuthTag(decoded(envelope.tag, TAG_BYTES));
    return Buffer.concat([
      decipher.update(decoded(envelope.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ProviderKeyError(
      "Saved provider credentials cannot be decrypted. Restore the original provider key and matching database backup.",
    );
  }
}
