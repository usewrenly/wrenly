/** Durable provider creation journal; a created Coolify record is not a ready app database. */
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "../projects/projects";
import { user } from "../identity/auth";
import type { AppDatabaseSecretEnvelope } from "./app-databases";
export const productionDatabaseProvisions = pgTable("production_database_provisions", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  sessionId: text("session_id").notNull(),
  accountRevision: uuid("account_revision").notNull(),
  accessRevision: uuid("access_revision").notNull(),
  requestId: uuid("request_id").notNull(),
  requestIdentity: text("request_identity").notNull(),
  placement: jsonb("placement").$type<Record<string, string>>().notNull(),
  secrets: jsonb("secrets").$type<AppDatabaseSecretEnvelope>().notNull(),
  status: text("status").$type<"queued" | "creating" | "created" | "needs_review" | "failed">().notNull().default("queued"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  effectStartedAt: timestamp("effect_started_at", { withTimezone: true }),
  remoteUuid: text("remote_uuid"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("production_database_provision_request_unique").on(table.actorId, table.requestId),
  index("production_database_provision_project_status_idx").on(table.projectId, table.status),
]);
