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
export const ProductionProjectInspectionReceipt = z
  .object({
    reviewId: z.uuid(),
    resourceId: z.uuid(),
    phase: ProductionProvisionPhase,
    status: z.enum([
      "queued",
      "checking",
      "confirmed",
      "absent",
      "refused",
      "interrupted",
    ]),
    replayed: z.boolean(),
  })
  .strict();

export const ProductionProjectCreationState = z
  .object({
    projectId: z.uuid(),
    projectRevision: z.uuid(),
    review: ProductionProjectInspectionReceipt.omit({ replayed: true })
      .extend({ requestId: z.uuid(), resumedRequestId: z.uuid().nullable() })
      .strict()
      .nullable()
      .optional(),
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
    if (value.review && value.review.resourceId !== value.creation?.resourceId)
      context.addIssue({
        code: "custom",
        message: "Foreign Production inspection.",
      });
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

/** Inspection and continuation are separate owner actions; neither accepts SQL or connection credentials. */
export const ProductionProjectRecoveryInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inspect"),
      requestId: z.uuid(),
      expectedRevision: z.uuid(),
      resourceId: z.uuid(),
      confirmInspect: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("continue"),
      requestId: z.uuid(),
      expectedRevision: z.uuid(),
      reviewId: z.uuid(),
      confirmContinue: z.literal(true),
    })
    .strict(),
]);
export type ProductionProjectRecoveryInput = z.infer<
  typeof ProductionProjectRecoveryInput
>;
export const ProductionProjectRecoveryReceipt = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inspect"),
      receipt: ProductionProjectInspectionReceipt,
    })
    .strict(),
  z
    .object({
      kind: z.literal("continue"),
      receipt: ProductionProjectCreationReceipt,
    })
    .strict(),
]);
