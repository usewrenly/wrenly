// Stores saved ideas and their explicit collaborators without framework or build execution state.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { user } from "../identity/auth";
import { projectAccessModeEnum, projectMemberRoleEnum } from "./projects";
export const projectDrafts = pgTable(
  "project_drafts",
  {
    id: uuid("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    revision: uuid("revision").notNull().defaultRandom(),
    accessMode: projectAccessModeEnum("access_mode")
      .notNull()
      .default("private"),
    instanceRole: projectMemberRoleEnum("instance_role")
      .notNull()
      .default("viewer"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("project_drafts_owner_updated").on(table.ownerId, table.updatedAt),
  ],
);
export const projectDraftMembers = pgTable(
  "project_draft_members",
  {
    draftId: uuid("draft_id")
      .notNull()
      .references(() => projectDrafts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: projectMemberRoleEnum("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.userId] })],
);
export const projectDraftActions = pgTable(
  "project_draft_actions",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => projectDrafts.id, { onDelete: "restrict" }),
    requestIdentity: text("request_identity").notNull(),
    revision: uuid("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.actorId, table.requestId] })],
);
