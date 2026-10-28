// Binds shared project inference to a selected connection/version; credentials remain in provider storage.
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { providerConnections } from "../configuration/provider-connections";
export const projectModels = pgTable("project_models", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => providerConnections.id, { onDelete: "restrict" }),
  modelId: text("model_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
