// Separate immutable preview/database evidence; existing stateless previews need no row.
import { pgTable, uuid, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AppDatabaseSocketIdentity,
  PreviewDatabaseEffect,
  PreviewDatabaseCleanupEffect,
} from "../../application-databases/runtime-contract";
import type { ValidatedDatabaseRevision } from "../../application-databases/binding-contract";
import { previews } from "./previews";
import { appDatabases } from "./app-databases";

export const previewDatabaseBindings = pgTable("preview_database_bindings", {
  previewId: uuid("preview_id")
    .primaryKey()
    .references(() => previews.id, { onDelete: "cascade" }),
  resourceId: uuid("resource_id")
    .notNull()
    .references(() => appDatabases.id, { onDelete: "restrict" }),
  revision: jsonb("revision").$type<ValidatedDatabaseRevision>().notNull(),
});

// Separate cleanup ownership survives cancellation without granting new application execution.
export const previewDatabaseRuntime = pgTable("preview_database_runtime", {
  previewId: uuid("preview_id")
    .primaryKey()
    .references(() => previewDatabaseBindings.previewId, {
      onDelete: "cascade",
    }),
  effect: jsonb("effect").$type<PreviewDatabaseEffect>(),
  completedEffects: jsonb("completed_effects")
    .$type<PreviewDatabaseEffect[]>()
    .notNull()
    .default([]),
  imageId: text("image_id"),
  socket: jsonb("socket").$type<AppDatabaseSocketIdentity>(),
  cleanupEffect: jsonb("cleanup_effect").$type<PreviewDatabaseCleanupEffect>(),
  completedCleanupEffects: jsonb("completed_cleanup_effects")
    .$type<PreviewDatabaseCleanupEffect[]>()
    .notNull()
    .default([]),
  cleanupToken: uuid("cleanup_token"),
  cleanupLeaseExpiresAt: timestamp("cleanup_lease_expires_at", {
    withTimezone: true,
  }),
  cleanupDeadlineAt: timestamp("cleanup_deadline_at", { withTimezone: true }),
});
