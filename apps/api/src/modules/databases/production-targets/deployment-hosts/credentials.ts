/** Dedicated host credentials are authenticated against their owner, destination and Coolify server. */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  ProductionRuntimeHostInput,
  ProductionRuntimeHostTarget,
} from "@wrenly/db/production-host-contract";
import {
  encryptDatabaseSecret,
  decryptDatabaseSecret,
  type DatabaseSecretEnvelope,
} from "../../database-secrets";
export interface RuntimeHostSecretScope {
  id: string;
  actorId: string;
  serverId: string;
  target: ProductionRuntimeHostTarget;
}
function purpose(scope: RuntimeHostSecretScope): string {
  z.uuid().parse(scope.id);
  z.string().min(1).max(256).parse(scope.actorId);
  const serverId = ProductionRuntimeHostInput.shape.serverId.parse(
    scope.serverId,
  );
  const target = ProductionRuntimeHostTarget.parse(scope.target);
  return `production-host:v1:${createHash("sha256")
    .update(JSON.stringify([scope.id, scope.actorId, serverId, target]))
    .digest("hex")}`;
}
/** Keyed request identities prevent an unkeyed hash of a credential from entering the setup journal. */
export function runtimeHostRequestIdentity(
  input: ProductionRuntimeHostInput,
  actorId: string,
  key: Buffer,
): string {
  if (key.length !== 32) throw new Error("Invalid host credential key.");
  return createHmac("sha256", key)
    .update(JSON.stringify([actorId, ProductionRuntimeHostInput.parse(input)]))
    .digest("hex");
}
/** Call only after owner authorization; the encrypted value never includes a database credential. */
export function sealRuntimeHostCredential(
  input: ProductionRuntimeHostInput,
  scope: RuntimeHostSecretScope,
  key: Buffer,
): DatabaseSecretEnvelope {
  const value = ProductionRuntimeHostInput.parse(input);
  if (
    value.serverId !== scope.serverId ||
    JSON.stringify(value.target) !==
      JSON.stringify(ProductionRuntimeHostTarget.parse(scope.target))
  )
    throw new Error("Host credential target changed.");
  return encryptDatabaseSecret(value.privateKey, key, purpose(scope));
}
/** The caller must recheck the saved owner/session and work claim before decrypting. */
export function openRuntimeHostCredential(
  raw: unknown,
  scope: RuntimeHostSecretScope,
  key: Buffer,
): string {
  return ProductionRuntimeHostInput.shape.privateKey.parse(
    decryptDatabaseSecret(raw, key, purpose(scope)),
  );
}
