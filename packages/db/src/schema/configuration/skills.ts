// Stores immutable instruction versions and exact project selections; execution uses admitted snapshots.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  index,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "../identity/auth";
import { projects } from "../projects/projects";

export const skillLibraries = pgTable("skill_libraries", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "restrict" }),
});
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    revision: uuid("revision").notNull(),
    currentVersionId: uuid("current_version_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("skills_owner_updated").on(table.ownerId, table.updatedAt)],
);
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "restrict" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    document: text("document").notNull(),
    sha256: text("sha256").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: text("source").$type<"authored" | "imported">().notNull(),
    sourceUrl: text("source_url"),
    versionLabel: text("version_label"),
    licenseNotes: text("license_notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("skill_versions_skill_created").on(table.skillId, table.createdAt),
  ],
);
export const skillActions = pgTable(
  "skill_actions",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "restrict" }),
    requestIdentity: text("request_identity").notNull(),
    revision: uuid("revision").notNull(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.actorId, table.requestId] })],
);
export const projectSkills = pgTable(
  "project_skills",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.versionId] }),
    uniqueIndex("project_skills_position_unique").on(
      table.projectId,
      table.position,
    ),
  ],
);
