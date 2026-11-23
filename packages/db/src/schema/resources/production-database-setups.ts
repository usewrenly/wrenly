/** Encrypted owner-confirmed Production setup requests, separate from ready database resources. */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { projects } from "../projects/projects";
import { user } from "../identity/auth";
import type { AppDatabaseSecretEnvelope } from "./app-databases";
import type { ProductionDatabaseTarget } from "../../application-databases/production-target-contract";
import type { ProductionDatabaseInspection } from "../../application-databases/production-inspection";
export const productionDatabaseSetups = pgTable(
  "production_database_setups",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sessionId: text("session_id").notNull(),
    accountRevision: uuid("account_revision").notNull(),
    accessRevision: uuid("access_revision").notNull(),
    requestId: uuid("request_id").notNull(),
    requestIdentity: text("request_identity").notNull(),
    target: jsonb("target").$type<ProductionDatabaseTarget>().notNull(),
    secret: jsonb("secret").$type<AppDatabaseSecretEnvelope>().notNull(),
    status: text("status")
      .$type<"queued" | "checking" | "verified" | "failed" | "needs_review">()
      .notNull()
      .default("queued"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    verified: jsonb("verified").$type<ProductionDatabaseInspection>(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("production_database_setup_request_unique").on(
      table.actorId,
      table.requestId,
    ),
    index("production_database_setup_project_status_idx").on(
      table.projectId,
      table.status,
    ),
  ],
);
