// Browser-safe identities for matching saved code to a Development database.
import { z } from "zod";
const UUID = z.string().uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DatabaseBindingRequest = z
  .object({
    buildId: UUID,
    resourceId: UUID,
    resourceRevision: UUID,
    environment: z.literal("development"),
  })
  .strict();
export type DatabaseBindingRequest = z.infer<typeof DatabaseBindingRequest>;
export const DatabaseRevisionBinding = DatabaseBindingRequest.extend({
  version: z.literal(1),
  projectId: UUID,
  accessRevision: UUID,
  framework: z.enum(["nextjs", "laravel"]),
  migrationOperationId: UUID,
  migrationDigest: Digest,
  schemaDigest: Digest,
}).strict();
export type DatabaseRevisionBinding = z.infer<typeof DatabaseRevisionBinding>;
export const ValidatedDatabaseRevision = z
  .object({
    binding: DatabaseRevisionBinding,
    validationOperationId: UUID,
    sourceDigest: Digest,
  })
  .strict();
export type ValidatedDatabaseRevision = z.infer<
  typeof ValidatedDatabaseRevision
>;
