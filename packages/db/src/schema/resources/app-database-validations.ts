// Frozen inputs for disposable application checks; real application data is never stored here.
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { appDatabaseOperations } from "./app-databases";
import { builds } from "../execution/builds";
export const appDatabaseValidations = pgTable("app_database_validations", {
  operationId: uuid("operation_id")
    .primaryKey()
    .references(() => appDatabaseOperations.id, { onDelete: "restrict" }),
  buildId: uuid("build_id")
    .notNull()
    .references(() => builds.id, { onDelete: "restrict" }),
  buildToken: uuid("build_token").notNull(),
  accessRevision: uuid("access_revision").notNull(),
  resourceRevision: uuid("resource_revision").notNull(),
  framework: text("framework").notNull(),
  files: jsonb("files")
    .$type<Array<{ path: string; content: string }>>()
    .notNull(),
  sourceDigest: text("source_digest").notNull(),
  migrationDigest: text("migration_digest").notNull(),
  imageId: text("image_id"),
  ownsArtifact: boolean("owns_artifact").notNull().default(false),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  schemaDigest: text("schema_digest"),
});
