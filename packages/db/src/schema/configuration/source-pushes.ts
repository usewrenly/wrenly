/** Remote-write intent and receipts survive API shutdown; no credential is saved in an operation. */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "../identity/auth";
import { projects } from "../projects/projects";
import { builds } from "../execution/builds";
import type { SourceRepository, SourceChange } from "@wrenly/source-control";
export const sourcePushReviews = pgTable("source_push_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  buildId: uuid("build_id")
    .notNull()
    .references(() => builds.id, { onDelete: "restrict" }),
  accessRevision: uuid("access_revision").notNull(),
  connectionVersion: uuid("connection_version").notNull(),
  repository: jsonb("repository").$type<SourceRepository>().notNull(),
  baseCommit: text("base_commit").notNull(),
  baseTree: text("base_tree").notNull(),
  applicationRoot: text("application_root").notNull().default(""),
  branch: text("branch").notNull(),
  changes: jsonb("changes").$type<SourceChange[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const sourcePushOperations = pgTable(
  "source_push_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => sourcePushReviews.id, { onDelete: "restrict" }),
    sessionId: text("session_id").notNull(),
    accountRevision: uuid("account_revision").notNull(),
    requestId: uuid("request_id").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "success" | "needs_review" | "failed">()
      .notNull()
      .default("queued"),
    phase: text("phase")
      .$type<"preflight" | "tree" | "commit" | "ref" | "complete">()
      .notNull()
      .default("preflight"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    treeId: text("tree_id"),
    commitId: text("commit_id"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("source_push_user_request").on(table.userId, table.requestId),
    uniqueIndex("source_push_review_once").on(table.reviewId),
  ],
);
