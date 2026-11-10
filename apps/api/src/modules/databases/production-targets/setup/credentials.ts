/** Setup secrets use a distinct key directory and authenticated project/owner/target binding. */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { ProductionManagementCredential } from "@wrenly/db/production-connection-contract";
import { ProductionDatabaseTarget } from "@wrenly/db/production-database-target-contract";
import {
  encryptDatabaseSecret,
  decryptDatabaseSecret,
  type DatabaseSecretEnvelope,
} from "../../database-secrets";
const MAX_SECRET_BYTES = 24 * 1024;
export const ProductionSetupInput = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.uuid(),
    confirmTarget: z.literal(true),
    target: ProductionDatabaseTarget,
    credential: ProductionManagementCredential,
    certificateAuthority: z
      .string()
      .min(1)
      .max(16 * 1024)
      .optional(),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_SECRET_BYTES,
  );
export type ProductionSetupInput = z.infer<typeof ProductionSetupInput>;
export interface ProductionSetupBinding {
  id: string;
  projectId: string;
  actorId: string;
  accessRevision: string;
  target: ProductionDatabaseTarget;
}
function binding(value: ProductionSetupBinding): string {
  for (const id of [value.id, value.projectId, value.accessRevision])
    z.uuid().parse(id);
  if (!value.actorId) throw new Error("Missing setup owner");
  return `production-setup:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        value.id,
        value.projectId,
        value.actorId,
        value.accessRevision,
        ProductionDatabaseTarget.parse(value.target),
      ]),
    )
    .digest("hex")}`;
}
/** HMAC prevents the saved replay identity from becoming an offline password-guessing oracle. */
export function productionSetupRequestIdentity(
  projectId: string,
  actorId: string,
  input: ProductionSetupInput,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([projectId, actorId, ProductionSetupInput.parse(input)]),
    )
    .digest("hex");
}
/** Encrypt only the credential and CA; target identity is authenticated as additional data. */
export function sealProductionSetup(
  input: ProductionSetupInput,
  scope: ProductionSetupBinding,
  key: Buffer,
): DatabaseSecretEnvelope {
  const parsed = ProductionSetupInput.parse(input);
  if (
    JSON.stringify(parsed.target) !==
    JSON.stringify(ProductionDatabaseTarget.parse(scope.target))
  )
    throw new Error("Setup target mismatch");
  return encryptDatabaseSecret(
    JSON.stringify({
      credential: parsed.credential,
      certificateAuthority: parsed.certificateAuthority,
    }),
    key,
    binding(scope),
  );
}
/** Decrypt only after the caller rechecks the current session, owner, revision and claim. */
export function openProductionSetup(
  raw: unknown,
  scope: ProductionSetupBinding,
  key: Buffer,
): {
  credential: z.infer<typeof ProductionManagementCredential>;
  certificateAuthority?: string;
} {
  return z
    .object({
      credential: ProductionManagementCredential,
      certificateAuthority: z
        .string()
        .min(1)
        .max(16 * 1024)
        .optional(),
    })
    .strict()
    .parse(JSON.parse(decryptDatabaseSecret(raw, key, binding(scope))));
}
