/** Saved owner approvals connect chat to existing database operations without replaying inference. */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { conversationTurns } from "./conversations";
import { projects } from "../projects/projects";
import type { AccessPrincipal } from "../../application-databases/conversation-workflow";
import type { DatabaseAction } from "../../application-databases/action-contract";
import type { DatabaseMigrationReview } from "../../application-databases/resource-contract";
export const conversationDatabaseWorkflows = pgTable(
  "conversation_database_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => conversationTurns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: uuid("revision").notNull().defaultRandom(),
    accessRevision: uuid("access_revision").notNull(),
    prompt: text("prompt").notNull(),
    purpose: text("purpose").notNull(),
    state: text("state").notNull().default("proposed"),
    principal: jsonb("principal").$type<AccessPrincipal>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    resourceId: uuid("resource_id"),
    resourceRevision: uuid("resource_revision"),
    operation: jsonb("operation").$type<DatabaseAction>(),
    operationId: uuid("operation_id"),
    buildId: uuid("build_id"),
    buildRequestId: uuid("build_request_id").notNull().defaultRandom(),
    review: jsonb("review").$type<DatabaseMigrationReview>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_database_turn_unique").on(table.turnId),
  ],
);
