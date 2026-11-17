/** Non-secret immutable server binding; local Docker identity belongs only to Development databases. */
import { z } from "zod";
const Base = z
  .object({
    version: z.literal("1"),
    provider: z.literal("postgres-cluster"),
    connectionId: z.uuid(),
    clusterId: z.string().regex(/^[0-9]{1,20}$/),
    database: z.string().regex(/^wrenly_[a-f0-9]{32}$/),
  })
  .strict();
export const ProductionResourceBinding = Base.extend({
  networkId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProductionResourceBinding = z.infer<
  typeof ProductionResourceBinding
>;
export const PendingProductionResourceBinding = Base;
export type PendingProductionResourceBinding = z.infer<typeof Base>;
/** Verifies that a saved server binding names this exact resource rather than another project's database. */
export function parseProductionResourceBinding(
  resourceId: string,
  input: unknown,
): ProductionResourceBinding {
  z.uuid().parse(resourceId);
  const binding = ProductionResourceBinding.parse(input);
  if (binding.database !== `wrenly_${resourceId.replaceAll("-", "")}`)
    throw new Error("Production resource database identity changed.");
  return binding;
}

/** A later operation has its own current session/access snapshot; it never inherits setup's expired session. */
export const ProductionOperationPrincipal = z
  .object({
    userId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    revision: z.uuid(),
    accessRevision: z.uuid(),
  })
  .strict();
export type ProductionOperationPrincipal = z.infer<
  typeof ProductionOperationPrincipal
>;
