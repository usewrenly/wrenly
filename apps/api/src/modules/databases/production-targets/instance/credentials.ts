/** Instance management credentials have their own authenticated identity and encryption purpose. */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  encryptDatabaseSecret,
  decryptDatabaseSecret,
  type DatabaseSecretEnvelope,
} from "../../database-secrets";
import { ProductionConnectionInput } from "@wrenly/db/production-connection-contract";
export { ProductionConnectionInput } from "@wrenly/db/production-connection-contract";
export interface ConnectionSecretScope {
  id: string;
  actorId: string;
  target: ProductionConnectionInput["target"];
}
function purpose(scope: ConnectionSecretScope): string {
  z.uuid().parse(scope.id);
  if (!scope.actorId) throw new Error("Missing instance owner");
  const target = ProductionConnectionInput.shape.target.parse(scope.target);
  return `production-instance:v1:${createHash("sha256")
    .update(JSON.stringify([scope.id, scope.actorId, target]))
    .digest("hex")}`;
}
/** A keyed identity cannot be used to guess a saved management password offline. */
export function productionConnectionRequestIdentity(
  input: ProductionConnectionInput,
  ownerId: string,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([ownerId, ProductionConnectionInput.parse(input)]))
    .digest("hex");
}
/** Credentials are never part of the browser receipt or a project's generated files. */
export function sealProductionConnection(
  input: ProductionConnectionInput,
  scope: ConnectionSecretScope,
  key: Buffer,
): DatabaseSecretEnvelope {
  const value = ProductionConnectionInput.parse(input);
  if (JSON.stringify(value.target) !== JSON.stringify(scope.target))
    throw new Error("Connection target changed");
  return encryptDatabaseSecret(
    JSON.stringify({
      credential: value.credential,
      certificateAuthority: value.certificateAuthority,
    }),
    key,
    purpose(scope),
  );
}
/** Call only after rechecking authorized session, connection identity and the operation/read claim. */
export function openProductionConnection(
  raw: unknown,
  scope: ConnectionSecretScope,
  key: Buffer,
): {
  credential: ProductionConnectionInput["credential"];
  certificateAuthority?: string;
} {
  const secret: unknown = JSON.parse(
    decryptDatabaseSecret(raw, key, purpose(scope)),
  );
  return z
    .object({
      credential: ProductionConnectionInput.shape.credential,
      certificateAuthority:
        ProductionConnectionInput.shape.certificateAuthority,
    })
    .strict()
    .parse(secret);
}
