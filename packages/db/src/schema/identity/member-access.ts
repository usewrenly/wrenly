// Records access changes without deleting identities or reassigning their projects.
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
export const memberAccessAudit = pgTable("member_access_audit", {
  id: uuid("id").primaryKey(),
  actorId: text("actor_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  targetId: text("target_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  previousRevision: uuid("previous_revision").notNull(),
  revision: uuid("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
