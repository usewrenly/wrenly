/** Source credential envelopes reuse the instance's audited AES-GCM primitive, with a separate key and scope. */
import { join } from "node:path";
import { z } from "zod";
import {
  loadProviderKey,
  encryptProviderToken,
  decryptProviderToken,
} from "../../models/credentials/provider-secrets";
const AppCredential = z
  .object({
    clientSecret: z.string().min(1).max(1024),
    privateKey: z.string().min(1).max(6000),
  })
  .strict();
const UserCredential = z
  .object({
    accessToken: z.string().min(1).max(2048),
    refreshToken: z.string().min(1).max(2048),
  })
  .strict();
const Verifier = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Scope = z
  .object({
    kind: z.enum(["app", "user", "authorization"]),
    id: z.string().uuid(),
    userId: z.string().min(1).max(256),
  })
  .strict();
export type SourceCredentialScope = z.infer<typeof Scope>;
function binding(scope: SourceCredentialScope): string {
  const parsed = Scope.parse(scope);
  return `source-control:v1:${JSON.stringify([parsed.kind, parsed.id, parsed.userId])}`;
}
function checked(value: unknown, kind: SourceCredentialScope["kind"]): unknown {
  if (kind === "app") return AppCredential.parse(value);
  if (kind === "user") return UserCredential.parse(value);
  return Verifier.parse(value);
}
/** This separate key cannot be regenerated once source ciphertext exists. Include it in instance backups. */
export async function loadSourceCredentialKey(
  directory: string,
  encryptedCredentialsExist: boolean,
): Promise<Buffer> {
  return await loadProviderKey(
    join(directory, "source-control"),
    encryptedCredentialsExist,
  );
}
export function encryptSourceCredential(
  value: unknown,
  key: Buffer,
  scope: SourceCredentialScope,
): unknown {
  return encryptProviderToken(
    JSON.stringify(checked(value, scope.kind)),
    key,
    binding(scope),
  );
}
/** Returns authenticated plaintext only to a server caller that already verified the current account/session. */
export function decryptSourceCredential(
  value: unknown,
  key: Buffer,
  scope: SourceCredentialScope,
): unknown {
  try {
    return checked(
      JSON.parse(decryptProviderToken(value, key, binding(scope))),
      scope.kind,
    );
  } catch {
    throw new Error(
      "Source credentials cannot be read. Restore the original key and matching database backup.",
    );
  }
}
