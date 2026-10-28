// Bounded canonical pictures and removal tombstones share the control-database backup boundary.
import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
export const profilePictures = pgTable("profile_pictures", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  imageBase64: text("image_base64"),
  revision: uuid("revision").notNull(),
  mutationId: uuid("mutation_id").notNull(),
  expectedRevision: uuid("expected_revision"),
  contentHash: text("content_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
