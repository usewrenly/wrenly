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
export const ProductionRuntimeNetworkRequest =
  ProductionRuntimeVolumeRequest.extend({
    action: z.enum(["create-runtime-network", "inspect-runtime-network"]),
  });
export type ProductionRuntimeNetworkRequest = z.infer<
  typeof ProductionRuntimeNetworkRequest
>;
export const ProductionRuntimeNetworkReply = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    dockerId: ProductionRuntimeHostIdentity.shape.dockerId,
    network: z
      .object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        name: z.string().min(1).max(128),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const ProductionRuntimeApplicationInspection =
  ProductionRuntimeVolumeRequest.extend({
    action: z.literal("inspect-runtime-application"),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  });
export const ProductionRuntimeApplicationReply = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    dockerId: ProductionRuntimeHostIdentity.shape.dockerId,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    running: z.boolean(),
  })
  .strict();
export const ProductionRuntimeBrokerRequest =
  ProductionRuntimeVolumeRequest.extend({
    action: z.literal("create-runtime-broker"),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    networkId: z.string().regex(/^[a-f0-9]{64}$/),
    upstream: z
      .object({
        hostname: ProductionRuntimeHostTarget.shape.host,
        address: z.ipv4(),
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
    addresses: z.array(z.ipv4()).min(1).max(16),
    runtimeRole: z
      .object({
        user: z.string().max(64),
        password: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    certificateAuthority: z.string().max(32768).optional(),
  });
export const ProductionRuntimeBrokerReply = z
  .object({
    version: z.literal(1),
    nonce: z.uuid(),
    dockerId: ProductionRuntimeHostIdentity.shape.dockerId,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    networkId: z.string().regex(/^[a-f0-9]{64}$/),
    volumeName: z.string().max(128),
  })
  .strict();
export const ProductionRuntimeBrokerInspection =
  ProductionRuntimeVolumeRequest.extend({
    action: z.literal("inspect-runtime-broker"),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    networkId: z.string().regex(/^[a-f0-9]{64}$/),
    upstream: z
      .object({
        hostname: ProductionRuntimeHostTarget.shape.host,
        address: z.ipv4(),
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
  });
export const ProductionRuntimeBrokerInspectionReply =
  ProductionRuntimeBrokerReply.extend({
    running: z.boolean(),
    socketReady: z.boolean(),
  });
export const ProductionRuntimeApplicationStart =
  ProductionRuntimeApplicationInspection.extend({
    action: z.literal("start-runtime-application"),
    framework: z.enum(["nextjs", "laravel"]),
    runtimeRole: ProductionRuntimeBrokerRequest.shape.runtimeRole,
    appKey: z.string().max(64).nullable(),
    brokerId: z.string().regex(/^[a-f0-9]{64}$/),
    brokerImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    networkId: ProductionRuntimeBrokerRequest.shape.networkId,
    upstream: ProductionRuntimeBrokerRequest.shape.upstream,
    addresses: ProductionRuntimeBrokerRequest.shape.addresses,
  });
export const ProductionRuntimeApplicationDiscovery =
  ProductionRuntimeApplicationInspection.omit({ containerId: true }).extend({
    action: z.literal("find-runtime-application"),
  });
export const ProductionRuntimeIngressDiscovery =
  ProductionRuntimeApplicationDiscovery.extend({
    action: z.literal("find-runtime-ingress"),
  });
export const ProductionRuntimeHostRequest = z.union([
  ProductionRuntimeIngressDiscovery,
  ProductionRuntimeApplicationDiscovery,
  ProductionRuntimeApplicationStart,
  ProductionRuntimeBrokerInspection,
  ProductionRuntimeBrokerRequest,
  ProductionRuntimeApplicationInspection,
  ProductionRuntimeNetworkRequest,
  ProductionRuntimeHostInspection,
  ProductionRuntimeVolumeRequest,
]);
