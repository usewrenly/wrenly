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
