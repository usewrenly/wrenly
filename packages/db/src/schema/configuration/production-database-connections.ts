/** Immutable, encrypted instance-level app-server connection revisions; never project credentials. */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "../identity/auth";
import type { AppDatabaseSecretEnvelope } from "../resources/app-databases";
import type { ProductionDatabaseTarget } from "../../application-databases/production-target-contract";
import type { ProductionDatabaseInspection } from "../../application-databases/production-inspection";
export const productionDatabaseConnections = pgTable(
  "production_database_connections",
  {
    id: uuid("id").primaryKey(),
    previousId: uuid("previous_id"),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sessionId: text("session_id").notNull(),
    accountRevision: uuid("account_revision").notNull(),
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
    pinnedAddresses: jsonb("pinned_addresses").$type<string[]>(),
    verified: jsonb("verified").$type<ProductionDatabaseInspection>(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("production_database_connection_request_unique").on(
      table.actorId,
      table.requestId,
    ),
  ],
);
