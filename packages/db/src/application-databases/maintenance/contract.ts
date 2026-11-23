/** Non-secret permission for maintaining one approved publication; importing this module opens no connection. */
import { z } from "zod";
import { ALL_MAINTENANCE_STEPS } from "./attempt";
import {
  ProductionPublishingBinding,
  ProductionPublishingJournal,
  PRODUCTION_PUBLISHING_STEPS,
  validateProductionPublishingJournal,
} from "../production-publishing-contract";
import { ProductionOperationPrincipal } from "../production-cluster/resource-contract";

/** A current authenticated owner must confirm this independently of the original publishing request. */
export const ProductionMaintenanceGrant = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    revision: z.uuid(),
    requestId: z.uuid(),
    state: z.enum(["enabled", "paused", "revoked"]),
    confirmedAt: z.iso.datetime(),
    confirmedBy: ProductionOperationPrincipal,
    confirmMaintenance: z.literal(true),
    binding: ProductionPublishingBinding,
    publication: ProductionPublishingJournal,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.confirmedBy.userId !== value.binding.principal.userId ||
      value.confirmedBy.accessRevision !==
        value.binding.principal.accessRevision
    )
      context.addIssue({
        code: "custom",
        message: "Maintenance owner or project access changed.",
      });
    try {
      const journal = validateProductionPublishingJournal(
        value.binding,
        value.publication,
      );
      if (
        journal.pending ||
        journal.completed.length !== PRODUCTION_PUBLISHING_STEPS.length
      )
        throw new Error("Publication is incomplete.");
      const verifiedAt = journal.completed.at(-1)!.completedAt;
      if (Date.parse(value.confirmedAt) < Date.parse(verifiedAt))
        throw new Error("Confirmation predates publication.");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Maintenance requires a complete verified publication.",
      });
    }
  });
export type ProductionMaintenanceGrant = z.infer<
  typeof ProductionMaintenanceGrant
>;

/** Server-loaded current facts, not browser assertions or an old session's authority. */
export const ProductionMaintenanceEvidence = z
  .object({
    grantRevision: z.uuid(),
    ownerId: z.string().min(1).max(256),
    ownerRevision: z.uuid(),
    ownerActive: z.boolean(),
    projectAccessRevision: z.uuid(),
    projectArchived: z.boolean(),
    resourceRevision: z.uuid(),
    resourceReady: z.boolean(),
    schemaDigest: ProductionPublishingBinding.shape.schemaDigest,
    connectionId: z.uuid(),
    clusterId: ProductionPublishingBinding.shape.clusterId,
    hostConnectionId: z.uuid(),
    hostVerified: z.boolean(),
    dockerId: ProductionPublishingBinding.shape.dockerId,
    serverId: ProductionPublishingBinding.shape.serverId,
    conflictingWork: z.boolean(),
    publicationStatus: z.enum([
      "success",
      "failed",
      "interrupted",
      "cancelled",
    ]),
    binding: ProductionPublishingBinding,
    publication: ProductionPublishingJournal,
  })
  .strict();
export type ProductionMaintenanceEvidence = z.infer<
  typeof ProductionMaintenanceEvidence
>;
export type ProductionMaintenanceDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "invalid-evidence"
        | "permission-inactive"
        | "owner-changed"
        | "project-changed"
        | "resource-changed"
        | "host-changed"
        | "publication-changed"
        | "conflicting-work";
    };

/** Evaluate immediately before an effect under the caller's live database/lease/kernel-lock fences. */
export function assessProductionMaintenance(
  grantInput: unknown,
  currentInput: unknown,
  bindingInspectionOnly = false,
): ProductionMaintenanceDecision {
  const parsedGrant = ProductionMaintenanceGrant.safeParse(grantInput);
  const parsedCurrent = ProductionMaintenanceEvidence.safeParse(currentInput);
  if (!parsedGrant.success || !parsedCurrent.success)
    return { allowed: false, reason: "invalid-evidence" };
  const grant = parsedGrant.data,
    current = parsedCurrent.data,
    binding = grant.binding;
  if (
    (!bindingInspectionOnly && grant.state !== "enabled") ||
    current.grantRevision !== grant.revision
  )
    return { allowed: false, reason: "permission-inactive" };
  if (
    !current.ownerActive ||
    current.ownerId !== grant.confirmedBy.userId ||
    current.ownerRevision !== grant.confirmedBy.revision
  )
    return { allowed: false, reason: "owner-changed" };
  if (
    current.projectArchived ||
    current.projectAccessRevision !== binding.principal.accessRevision
  )
    return { allowed: false, reason: "project-changed" };
  if (
    !current.resourceReady ||
    current.resourceRevision !== binding.resourceRevision ||
    current.schemaDigest !== binding.schemaDigest ||
    current.connectionId !== binding.connectionId ||
    current.clusterId !== binding.clusterId
  )
    return { allowed: false, reason: "resource-changed" };
  if (
    !current.hostVerified ||
    current.hostConnectionId !== binding.hostConnectionId ||
    current.dockerId !== binding.dockerId ||
    current.serverId !== binding.serverId
  )
    return { allowed: false, reason: "host-changed" };
  if (
    current.publicationStatus !== "success" ||
    JSON.stringify(current.binding) !== JSON.stringify(binding) ||
    JSON.stringify(current.publication) !== JSON.stringify(grant.publication)
  )
    return { allowed: false, reason: "publication-changed" };
  if (current.conflictingWork)
    return { allowed: false, reason: "conflicting-work" };
  return { allowed: true };
}

/** Browser decisions contain only reviewed revisions; execution authority is constructed on the server. */
export const MaintenanceDecision = z
  .object({
    requestId: z.uuid(),
    expectedAccessRevision: z.uuid(),
    expectedGrantRevision: z.uuid().nullable(),
    state: z.enum(["enabled", "paused", "revoked"]),
    confirmMaintenance: z.literal(true),
  })
  .strict();
export type MaintenanceDecision = z.infer<typeof MaintenanceDecision>;
/** Public owner view excludes the saved infrastructure binding, claim tokens and credentials. */
export const MaintenanceView = z
  .object({
    accessRevision: z.uuid(),
    grantRevision: z.uuid().nullable(),
    state: z.enum(["disabled", "enabled", "paused", "revoked"]),
    attempt: z
      .object({
        status: z.enum(["running", "success", "interrupted", "reconciled"]),
        step: z.enum(ALL_MAINTENANCE_STEPS).nullable(),
        updatedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MaintenanceView = z.infer<typeof MaintenanceView>;
export const MaintenanceDecisionReceipt = z
  .object({
    requestId: z.uuid(),
    grantRevision: z.uuid(),
    state: z.enum(["enabled", "paused", "revoked"]),
    replayed: z.boolean(),
  })
  .strict();
export type MaintenanceDecisionReceipt = z.infer<
  typeof MaintenanceDecisionReceipt
>;

/** Owner actions are independent of the permission toggle and retain an exact lost-response lookup ID. */
export const MaintenanceControl = z
  .object({
    requestId: z.uuid(),
    expectedAccessRevision: z.uuid(),
    expectedGrantRevision: z.uuid().nullable(),
    kind: z.enum(["stop", "inspect"]),
    confirmRuntimeControl: z.literal(true),
  })
  .strict();
export type MaintenanceControl = z.infer<typeof MaintenanceControl>;
export const MaintenanceControlReceipt = z
  .object({
    requestId: z.uuid(),
    kind: z.enum(["stop", "inspect"]),
    status: z.enum(["running", "success", "interrupted", "reconciled"]),
    step: z.enum(ALL_MAINTENANCE_STEPS).nullable(),
    replayed: z.boolean(),
  })
  .strict();
export type MaintenanceControlReceipt = z.infer<
  typeof MaintenanceControlReceipt
>;
