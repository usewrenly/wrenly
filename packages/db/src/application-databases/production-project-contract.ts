/** Credential-free Production creation contracts shared by the API and browser. */
import { z } from "zod";
export const PRODUCTION_PROVISION_PHASES = [
  "roles",
  "database",
  "connections",
  "schema",
] as const;
export const ProductionProvisionPhase = z.enum(PRODUCTION_PROVISION_PHASES);
export type ProductionProvisionPhase = z.infer<typeof ProductionProvisionPhase>;
export const ProductionProjectCreationInput = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.uuid(),
    connectionId: z.uuid(),
    confirmCreate: z.literal(true),
  })
  .strict();
export type ProductionProjectCreationInput = z.infer<
  typeof ProductionProjectCreationInput
>;
export const ProductionProjectCreationReceipt = z
  .object({
    resourceId: z.uuid(),
    status: z.enum([
      "queued",
      "creating",
      "created",
      "attached",
      "needs_review",
      "failed",
    ]),
    completedPhases: z
      .array(ProductionProvisionPhase)
      .max(PRODUCTION_PROVISION_PHASES.length),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.completedPhases.some(
        (phase, index) => phase !== PRODUCTION_PROVISION_PHASES[index],
      ) ||
      (["created", "attached"].includes(value.status) &&
        value.completedPhases.length !== PRODUCTION_PROVISION_PHASES.length)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid saved Production creation progress.",
      });
  });
export const ProductionProjectCreationState = z
  .object({
    projectId: z.uuid(),
    projectRevision: z.uuid(),
    connectionId: z.uuid().nullable(),
    creation: z
      .object({
        resourceId: z.uuid(),
        requestId: z.uuid(),
        status: ProductionProjectCreationReceipt.shape.status,
        completedPhases: ProductionProjectCreationReceipt.shape.completedPhases,
        errorCode: z
          .enum([
            "sql_creation_interrupted",
            "sql_phase_unconfirmed",
            "access_changed",
          ])
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.creation &&
      !ProductionProjectCreationReceipt.safeParse({
        resourceId: value.creation.resourceId,
        status: value.creation.status,
        completedPhases: value.creation.completedPhases,
        replayed: false,
      }).success
    )
      context.addIssue({
        code: "custom",
        message: "Invalid saved Production creation progress.",
      });
  });
