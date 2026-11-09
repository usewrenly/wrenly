/** Reviewed immutable source is saved locally before project creation; callbacks never admit builds. */
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
import type { SourceRepository, SourceFile } from "@wrenly/source-control";
export const sourceImportReviews = pgTable("source_import_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  connectionVersion: uuid("connection_version").notNull(),
  repository: jsonb("repository").$type<SourceRepository>().notNull(),
  commitId: text("commit_id").notNull(),
  treeId: text("tree_id").notNull(),
  stack: text("stack").$type<"nextjs" | "laravel">().notNull(),
  files: jsonb("files").$type<SourceFile[]>().notNull(),
  excludedPaths: jsonb("excluded_paths").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
/** A saved import acknowledgement makes a lost HTTP reply safe to read again without duplicating a project. */
export const sourceProjectOrigins = pgTable(
  "source_project_origins",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    requestIdentity: text("request_identity").notNull(),
    reviewId: uuid("review_id").notNull(),
    buildId: uuid("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "restrict" }),
    repository: jsonb("repository").$type<SourceRepository>().notNull(),
    commitId: text("commit_id").notNull(),
    treeId: text("tree_id").notNull(),
    baseline: jsonb("baseline").$type<SourceFile[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("source_import_user_request").on(table.userId, table.requestId),
    uniqueIndex("source_import_review_once").on(table.reviewId),
  ],
);
