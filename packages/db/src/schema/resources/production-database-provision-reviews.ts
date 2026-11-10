/** Owner-confirmed read-only inspections of uncertain creation, retained separately from the original request. */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { productionDatabaseProvisions } from "./production-database-provisions";
import { user } from "../identity/auth";
import type { ProductionProvisionPhase } from "../../application-databases/production-cluster/contract";
export const productionDatabaseProvisionReviews = pgTable(
  "production_database_provision_reviews",
  {
    id: uuid("id").primaryKey(),
    provisionId: uuid("provision_id")
      .notNull()
      .references(() => productionDatabaseProvisions.id, {
        onDelete: "restrict",
      }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sessionId: text("session_id").notNull(),
    accountRevision: uuid("account_revision").notNull(),
    accessRevision: uuid("access_revision").notNull(),
    requestId: uuid("request_id").notNull(),
    phase: text("phase").$type<ProductionProvisionPhase>().notNull(),
    priorCompletedPhases: jsonb("prior_completed_phases")
      .$type<ProductionProvisionPhase[]>()
      .notNull(),
    effectStartedAt: timestamp("effect_started_at", { withTimezone: true }),
    status: text("status")
      .$type<
        | "queued"
        | "checking"
        | "confirmed"
        | "absent"
        | "refused"
        | "interrupted"
      >()
      .notNull()
      .default("queued"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    resumedRequestId: uuid("resumed_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("production_provision_review_actor_request_unique").on(
      table.actorId,
      table.requestId,
    ),
  ],
);
