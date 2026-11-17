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
import type {
  ProductionRuntimeHostTarget,
  ProductionRuntimeHostIdentity,
} from "../../application-databases/production-host-contract";
/** One-time deployment machine registrations are separate from PostgreSQL server credentials. */
export const productionRuntimeHosts = pgTable(
  "production_runtime_hosts",
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
    serverId: text("server_id").notNull(),
    target: jsonb("target").$type<ProductionRuntimeHostTarget>().notNull(),
    secret: jsonb("secret").$type<AppDatabaseSecretEnvelope>().notNull(),
    status: text("status")
      .$type<"queued" | "checking" | "verified" | "failed" | "needs_review">()
      .notNull()
      .default("queued"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    pinnedAddresses: jsonb("pinned_addresses").$type<string[]>(),
    verified: jsonb("verified").$type<ProductionRuntimeHostIdentity>(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("production_runtime_host_request_unique").on(
      table.actorId,
      table.requestId,
    ),
  ],
);
