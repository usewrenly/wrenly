// Browser-safe database status shared by API and UI. No SQL, client or environment imports.
import { z } from "zod";
import { DatabaseEnvironment } from "./action-contract";
const Identifier = z.string().uuid();
const Time = z.union([z.date().transform(value => value.toISOString()), z.string().datetime()]);
const ErrorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable();
export const DATABASE_STATUS_LIMITS = { resources: 2, operations: 8, bytes: 32 * 1024 } as const;
export const DatabaseResourceStatus = z.object({
  capabilities: z.object({ manage: z.boolean(), developmentRows: z.boolean(), productionRows: z.boolean() }).strict(),
  resources: z.array(z.object({
    id: Identifier, projectId: Identifier, environment: DatabaseEnvironment,
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    status: z.enum(["provisioning", "ready", "stopped", "failed", "recovery_required"]),
    revision: Identifier, schemaDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    errorCode: ErrorCode, createdAt: Time, updatedAt: Time,
  }).strict()).max(DATABASE_STATUS_LIMITS.resources),
  operations: z.array(z.object({
    id: Identifier, databaseId: Identifier,
    kind: z.enum(["create", "start", "stop", "backup", "migrate", "read", "recover-read", "recover-before-effect", "recover-runtime-state", "validate-application", "recover-validation"]),
    status: z.enum(["queued", "running", "success", "failed", "interrupted"]),
    errorCode: ErrorCode, createdAt: Time, completedAt: Time.nullable(),
  }).strict()).max(DATABASE_STATUS_LIMITS.operations),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.resources.map(resource => resource.id));
  const environments = new Set(value.resources.map(resource => resource.environment));
  if (ids.size !== value.resources.length || environments.size !== value.resources.length ||
      new Set(value.operations.map(operation => operation.id)).size !== value.operations.length ||
      value.operations.some(operation => !ids.has(operation.databaseId)) ||
      value.capabilities.productionRows !== value.capabilities.manage ||
      (value.capabilities.manage && !value.capabilities.developmentRows)) {
    context.addIssue({ code: "custom", message: "Database status identities and capabilities must agree." });
  }
});
export type DatabaseResourceStatus = z.infer<typeof DatabaseResourceStatus>;

/** Review names the selected saved source and resource; reading it never authorizes execution. */
export const DatabaseMigrationReview = z.object({
  projectId: Identifier, resourceId: Identifier, revision: Identifier, buildId: Identifier,
  framework: z.enum(["nextjs", "laravel"]),
  migrationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().max(512 * 1024) }).strict()).min(1).max(129),
  backups: z.array(z.object({ id: Identifier, verifiedAt: Time,
    schemaDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(16),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 768 * 1024 ||
      new Set(value.files.map(file => file.path)).size !== value.files.length ||
      new Set(value.backups.map(backup => backup.id)).size !== value.backups.length)
    context.addIssue({ code: "custom", message: "Review exceeds its identity or size bounds." });
});
export type DatabaseMigrationReview = z.infer<typeof DatabaseMigrationReview>;

/** Only server-reviewed recovery choices cross into the browser; external effect details remain private. */
export const DatabaseRecoveryReview = z.object({
  projectId: Identifier, resourceId: Identifier, revision: Identifier, operationId: Identifier,
  choices: z.array(z.enum(["recover-before-effect", "recover-runtime-state", "recover-read", "recover-validation"])).max(1),
}).strict();
export type DatabaseRecoveryReview = z.infer<typeof DatabaseRecoveryReview>;
