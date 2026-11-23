/** Browser/server setup contracts contain no client, environment loading or stored encryption fields. */
import { z } from "zod";
import { ProductionDatabaseTarget } from "./production-target-contract";
const MAX_REQUEST_BYTES = 24 * 1024;
export const ProductionManagementCredential = z
  .object({
    user: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
    password: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
  })
  .strict();
export const ProductionConnectionInput = z
  .object({
    requestId: z.uuid(),
    expectedConnectionId: z.uuid().nullable(),
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
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_REQUEST_BYTES,
  );
export type ProductionConnectionInput = z.infer<
  typeof ProductionConnectionInput
>;
export const ProductionConnectionStatus = z.enum([
  "queued",
  "checking",
  "verified",
  "failed",
  "needs_review",
]);
export const ProductionConnectionReceipt = z
  .object({
    connectionId: z.uuid(),
    status: ProductionConnectionStatus,
    replayed: z.boolean(),
  })
  .strict();
export type ProductionConnectionReceipt = z.infer<
  typeof ProductionConnectionReceipt
>;
export const ProductionConnectionState = z
  .object({
    connectionId: z.uuid(),
    status: ProductionConnectionStatus,
    target: ProductionDatabaseTarget,
    verified: z
      .object({
        clusterId: z.string().regex(/^[0-9]{1,20}$/),
        database: z.string().min(1).max(63),
        setupRole: z.string().min(1).max(63),
        serverVersion: z.number().int().min(170000).max(179999),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ProductionConnectionState = z.infer<
  typeof ProductionConnectionState
>;
export const ProductionConnectionAcknowledgement = z
  .object({ connectionId: z.uuid(), confirmInterruptedCheck: z.literal(true) })
  .strict();
