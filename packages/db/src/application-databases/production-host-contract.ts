/** Pure fixed-helper and private host contracts; no connections, credentials or process environment are loaded. */
import { z } from "zod";
const Hostname = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
export const ProductionRuntimeHostTarget = z
  .object({
    host: Hostname,
    port: z.number().int().min(1).max(65535),
    user: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z_][a-z0-9_-]*$/),
    hostKey: z
      .string()
      .regex(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/),
  })
  .strict();
export type ProductionRuntimeHostTarget = z.infer<
  typeof ProductionRuntimeHostTarget
>;
export const ProductionRuntimeHostInspection = z
  .object({
    version: z.literal(1),
    action: z.literal("inspect"),
    nonce: z.uuid(),
  })
  .strict();
export const ProductionRuntimeHostIdentity = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    dockerId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9:-]+$/),
    operatingSystem: z.literal("linux"),
    architecture: z.enum(["x86_64", "aarch64"]),
    helperVersion: z.literal(1),
  })
  .strict();
export type ProductionRuntimeHostIdentity = z.infer<
  typeof ProductionRuntimeHostIdentity
>;

/** Setup binds this host to one reviewed Coolify server; changing servers requires a new connection. */
export const ProductionRuntimeHostInput = z
  .object({
    requestId: z.uuid(),
    expectedConnectionId: z.uuid().nullable(),
    confirmTarget: z.literal(true),
    serverId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/),
    target: ProductionRuntimeHostTarget,
    privateKey: z
      .string()
      .max(16 * 1024)
      .regex(
        /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\s*$/,
      ),
  })
  .strict();
export type ProductionRuntimeHostInput = z.infer<
  typeof ProductionRuntimeHostInput
>;

/** Public setup receipts share lifecycle names with database setup, never credential fields. */
export const ProductionRuntimeHostReceipt = z
  .object({
    connectionId: z.uuid(),
    status: z.enum([
      "queued",
      "checking",
      "verified",
      "failed",
      "needs_review",
    ]),
    replayed: z.boolean(),
  })
  .strict();
export const ProductionRuntimeHostState = z
  .object({
    connectionId: z.uuid(),
    status: ProductionRuntimeHostReceipt.shape.status,
    serverId: ProductionRuntimeHostInput.shape.serverId,
    target: ProductionRuntimeHostTarget,
    verified: ProductionRuntimeHostIdentity.nullable(),
  })
  .strict();
export const ProductionRuntimeHostAcknowledgement = z
  .object({ connectionId: z.uuid(), confirmInterruptedCheck: z.literal(true) })
  .strict();

/** Mutations carry the caller's persisted operation identity; no command, path or credential is selectable. */
export const ProductionRuntimeVolumeRequest = z
  .object({
    version: z.literal(1),
    action: z.enum([
      "create-http-volume",
      "create-database-volume",
      "inspect-runtime-volumes",
    ]),
    nonce: z.uuid(),
    expectedDockerId: ProductionRuntimeHostIdentity.shape.dockerId,
    deploymentId: z.uuid(),
    projectId: z.uuid(),
    resourceId: z.uuid(),
    claimToken: z.uuid(),
    confirmDurableIntent: z.literal(true),
  })
  .strict();
export type ProductionRuntimeVolumeRequest = z.infer<
  typeof ProductionRuntimeVolumeRequest
>;
export const ProductionRuntimeVolumeFact = z
  .object({
    name: z.string().min(1).max(128),
    createdAt: z.string().min(1).max(64),
  })
  .strict();
export const ProductionRuntimeVolumeReply = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    dockerId: ProductionRuntimeHostIdentity.shape.dockerId,
    http: ProductionRuntimeVolumeFact.nullable(),
    database: ProductionRuntimeVolumeFact.nullable(),
  })
  .strict();
export const ProductionRuntimeHostRequest = z.union([
  ProductionRuntimeHostInspection,
  ProductionRuntimeVolumeRequest,
]);
