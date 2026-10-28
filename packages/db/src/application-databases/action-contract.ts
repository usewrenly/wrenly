// Pure action input and saved-acknowledgement contracts shared by API and UI.
import { z } from "zod";
export const DatabaseEnvironment = z.enum(["development", "production"]);
export type DatabaseEnvironment = z.infer<typeof DatabaseEnvironment>;
export const DatabaseAction = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.string().uuid().nullable(),
    environment: DatabaseEnvironment,
    kind: z.enum(["create", "start", "stop", "backup", "migrate"]),
    buildId: z.string().uuid().optional(),
    backupId: z.string().uuid().optional(),
    confirmChanges: z.literal(true).optional(),
    migrationDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.kind !== "create" && action.expectedRevision === null)
      context.addIssue({
        code: "custom",
        message: "Use the current resource revision for existing resources.",
      });
    if (
      action.kind === "migrate"
        ? !action.buildId ||
          !action.migrationDigest ||
          !action.backupId ||
          !action.confirmChanges
        : action.buildId !== undefined ||
          action.migrationDigest !== undefined ||
          action.backupId !== undefined ||
          action.confirmChanges !== undefined
    )
      context.addIssue({
        code: "custom",
        message:
          "Only migration actions require an exact build and migration digest.",
      });
  });
export type DatabaseAction = z.infer<typeof DatabaseAction>;
export const DatabaseActionAcknowledgement = z.object({
  operationId: z.string().uuid(), resourceId: z.string().uuid(), replayed: z.boolean(),
}).strict();
export type DatabaseActionAcknowledgement = z.infer<typeof DatabaseActionAcknowledgement>;
export const DatabaseActionLookup = z.object({ acknowledgement: DatabaseActionAcknowledgement.nullable() }).strict();

// Recovery identifies the interrupted operation; it never supplies replacement SQL.
export const DatabaseRecovery = z.object({
  requestId: z.string().uuid(),
  operationId: z.string().uuid(),
  expectedRevision: z.string().uuid(),
}).strict();
export type DatabaseRecovery = z.infer<typeof DatabaseRecovery>;
export const DatabaseRecoveryAction = DatabaseRecovery.extend({
  kind: z.enum(["recover-before-effect", "recover-runtime-state", "recover-read", "recover-validation"]),
  confirmRecovery: z.literal(true),
}).strict();
export type DatabaseRecoveryAction = z.infer<typeof DatabaseRecoveryAction>;
