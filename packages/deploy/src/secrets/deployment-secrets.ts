/**
 * Deployment secret envelopes
 * Used by deployment persistence to encrypt and authenticate saved runtime credentials.
 * AES-GCM binds each envelope to its project and purpose, preventing cross-scope substitution.
 * This module owns the envelope contract; callers import its types. Never publish ciphertext or log plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SECRET_BYTES = 64 * 1024;
const ALGORITHM = "aes-256-gcm";
const SECRET_PURPOSES = [
  "git-deploy-private-key",
  "laravel-app-key",
  "runtime-environment",
] as const;
export type DeploymentSecretPurpose = (typeof SECRET_PURPOSES)[number];
export interface EncryptedDeploymentSecret {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}

function encryptionKey(key: string): Buffer {
  if (key.length !== KEY_BYTES * 2 || !/^[a-f0-9]+$/i.test(key))
    throw new Error("Invalid deployment encryption key.");
  return Buffer.from(key, "hex");
}

/** Scope is authenticated rather than encrypted so a copied envelope cannot change owners. */
function associatedData(
  projectId: string,
  purpose: DeploymentSecretPurpose,
): Buffer {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      projectId,
    ) ||
    !SECRET_PURPOSES.includes(purpose)
  )
    throw new Error("Invalid deployment secret scope.");
  return Buffer.from(
    JSON.stringify([
      "wrenly-deployment-secret",
      1,
      projectId.toLowerCase(),
      purpose,
    ]),
  );
}

/** Require canonical base64 so malformed envelopes have one unambiguous representation. */
function decode(value: unknown, expectedBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_SECRET_BYTES / 3) * 4
  )
    throw new Error("Invalid encrypted deployment secret.");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    decoded.length === 0 ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes) ||
    decoded.length > MAX_SECRET_BYTES
  )
    throw new Error("Invalid encrypted deployment secret.");
  return decoded;
}

/** Encrypts secrets with project/purpose binding; ciphertext is safe to persist, not publish. */
export function encryptDeploymentSecret(
  plaintext: string,
  key: string,
  projectId: string,
  purpose: DeploymentSecretPurpose,
): EncryptedDeploymentSecret {
  if (!plaintext || Buffer.byteLength(plaintext) > MAX_SECRET_BYTES)
    throw new Error("Deployment secret is empty or exceeds its size limit.");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(key), nonce);
  cipher.setAAD(associatedData(projectId, purpose));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Authenticates ciphertext before returning any plaintext; failures never include secret values. */
export function decryptDeploymentSecret(
  envelope: unknown,
  key: string,
  projectId: string,
  purpose: DeploymentSecretPurpose,
): string {
  try {
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("version" in envelope) ||
      envelope.version !== 1 ||
      !("nonce" in envelope) ||
      !("tag" in envelope) ||
      !("ciphertext" in envelope)
    )
      throw new Error("Invalid envelope");
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(key),
      decode(envelope.nonce, NONCE_BYTES),
    );
    decipher.setAAD(associatedData(projectId, purpose));
    decipher.setAuthTag(decode(envelope.tag, TAG_BYTES));
    return Buffer.concat([
      decipher.update(decode(envelope.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Deployment secret could not be authenticated. Check the encryption key and saved secret.",
    );
  }
}
