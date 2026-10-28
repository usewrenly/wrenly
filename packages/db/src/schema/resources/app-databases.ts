// Control metadata for separately hosted application databases; never generated tables or app rows.
// generated tables/data live in a different PostgreSQL resource, never this cluster.
import type { AppDatabaseRuntimeIdentity } from "../../application-databases/runtime-contract";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { projects } from "../projects/projects";
import { builds } from "../execution/builds";
import { user } from "../identity/auth";

export const appDatabaseEnvironment = pgEnum("app_database_environment", [
  "development",
  "production",
]);
export const appDatabaseStatus = pgEnum("app_database_status", [
  "provisioning",
  "ready",
  "stopped",
  "failed",
  "recovery_required",
]);
export const appDatabaseOperationStatus = pgEnum(
  "app_database_operation_status",
  ["queued", "running", "success", "failed", "interrupted"],
);
export interface AppDatabaseSecretEnvelope {
  version: 1;
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}
export type AppDatabaseIdentity = AppDatabaseRuntimeIdentity;
export interface AppDatabaseEffect {
  kind: string;
  id: string;
  startedAt: string;
}
export const appDatabaseQueue = pgTable("app_database_queue", {
  id: integer("id").primaryKey(),
});
export const appDatabases = pgTable(
  "app_databases",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    environment: appDatabaseEnvironment("environment").notNull(),
    provider: text("provider").notNull(),
    status: appDatabaseStatus("status").notNull().default("provisioning"),
    revision: uuid("revision").notNull().defaultRandom(),
    secrets: jsonb("secrets").$type<AppDatabaseSecretEnvelope>().notNull(),
    runtimeIdentity: jsonb("runtime_identity").$type<AppDatabaseIdentity>(),
    providerIdentity:
      jsonb("provider_identity").$type<Record<string, string>>(),
    schemaDigest: text("schema_digest"),
    errorCode: text("error_code"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_databases_project_environment_unique").on(
      table.projectId,
      table.environment,
    ),
  ],
);
export const appDatabaseOperations = pgTable(
  "app_database_operations",
  {
    id: uuid("id").primaryKey(),
    databaseId: uuid("database_id")
      .notNull()
      .references(() => appDatabases.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    requestIdentity: text("request_identity").notNull(),
    kind: text("kind").notNull(),
    status: appDatabaseOperationStatus("status").notNull().default("queued"),
    expectedRevision: uuid("expected_revision"),
    buildId: uuid("build_id").references(() => builds.id, {
      onDelete: "restrict",
    }),
    migrationDigest: text("migration_digest"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    effect: jsonb("effect").$type<AppDatabaseEffect>(),
    cleanupEffect: jsonb("cleanup_effect").$type<AppDatabaseEffect>(),
    completedCleanupEffects: jsonb("completed_cleanup_effects")
      .$type<AppDatabaseEffect[]>()
      .notNull()
      .default([]),
    completedEffects: jsonb("completed_effects")
      .$type<AppDatabaseEffect[]>()
      .notNull()
      .default([]),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("app_database_operations_actor_request_unique").on(
      table.actorId,
      table.requestId,
    ),
    index("app_database_operations_pending_index").on(
      table.status,
      table.createdAt,
    ),
  ],
);
export const appDatabaseMigrations = pgTable("app_database_migrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  databaseId: uuid("database_id")
    .notNull()
    .references(() => appDatabases.id, { onDelete: "restrict" }),
  operationId: uuid("operation_id")
    .notNull()
    .references(() => appDatabaseOperations.id, { onDelete: "restrict" }),
  buildId: uuid("build_id")
    .notNull()
    .references(() => builds.id, { onDelete: "restrict" }),
  digest: text("digest").notNull(),
  backupId: uuid("backup_id").references(() => appDatabaseBackups.id, {
    onDelete: "restrict",
  }),
  beforeSchemaDigest: text("before_schema_digest"),
  rehearsedSchemaDigest: text("rehearsed_schema_digest"),
  manifest: jsonb("manifest")
    .$type<Array<{ path: string; sha256: string }>>()
    .notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const appDatabaseBackups = pgTable("app_database_backups", {
  id: uuid("id").primaryKey(),
  databaseId: uuid("database_id")
    .notNull()
    .references(() => appDatabases.id, { onDelete: "restrict" }),
  operationId: uuid("operation_id")
    .notNull()
    .references(() => appDatabaseOperations.id, { onDelete: "restrict" }),
  schemaDigest: text("schema_digest"),
  sha256: text("sha256").notNull(),
  encryptedPath: text("encrypted_path").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
