/** Explicit permission and append-only owner decisions; these records never contain runtime credentials. */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { deployments } from "./deployments";
import { projects } from "../projects/projects";
import { user } from "../identity/auth";
import type { MaintenanceAttempt } from "../../application-databases/maintenance/attempt";
import type { ProductionMaintenanceGrant } from "../../application-databases/maintenance/contract";

export const productionRuntimeMaintenance = pgTable(
  "production_runtime_maintenance",
  {
    deploymentId: uuid("deployment_id")
      .primaryKey()
      .references(() => deployments.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    grant: jsonb("grant").$type<ProductionMaintenanceGrant>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/** Attempts are retained separately so withdrawing permission cannot erase an uncertain restart. */
export const productionRuntimeMaintenanceAttempts = pgTable(
  "production_runtime_maintenance_attempts",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    journal: jsonb("journal").$type<MaintenanceAttempt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

// Each decision retains its original result so a lost reply cannot become a second change.
export const productionRuntimeMaintenanceActions = pgTable(
  "production_runtime_maintenance_actions",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sessionId: text("session_id").notNull(),
    accountRevision: uuid("account_revision").notNull(),
    requestId: uuid("request_id").notNull(),
    requestIdentity: text("request_identity").notNull(),
    result: jsonb("result").$type<ProductionMaintenanceGrant>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("production_maintenance_actor_request_unique").on(
      table.actorId,
      table.requestId,
    ),
  ],
);
