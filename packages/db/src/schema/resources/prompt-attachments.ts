/** Private upload ownership is independent of project creation; admission binds a reference exactly once. */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { user } from "../identity/auth";
import { projects } from "../projects/projects";
export const promptAttachments = pgTable(
  "prompt_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    uploadRequestId: uuid("upload_request_id").notNull(),
    objectId: uuid("object_id").notNull(),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    boundRequestId: uuid("bound_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("prompt_attachments_owner_upload_unique").on(
      table.ownerId,
      table.uploadRequestId,
    ),
    uniqueIndex("prompt_attachments_object_unique").on(table.objectId),
    index("prompt_attachments_owner_expiry_idx").on(
      table.ownerId,
      table.expiresAt,
    ),
  ],
);
