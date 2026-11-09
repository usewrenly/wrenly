/** GitHub credentials belong to a local instance/user, never to generated source or model jobs. */
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { user, session } from "../identity/auth";
export const sourceGitHubApp = pgTable("source_github_app", {
  id: integer("id").primaryKey(),
  version: uuid("version").notNull().defaultRandom(),
  appId: text("app_id").notNull(),
  slug: text("slug").notNull(),
  clientId: text("client_id").notNull(),
  credential: jsonb("credential").$type<unknown>().notNull(),
  configuredBy: text("configured_by")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const sourceConnections = pgTable(
  "source_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: uuid("version").notNull().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    appVersion: uuid("app_version").notNull(),
    remoteUserId: text("remote_user_id").notNull(),
    remoteLogin: text("remote_login").notNull(),
    credential: jsonb("credential").$type<unknown>(),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", {
      withTimezone: true,
    }).notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("source_connection_user_provider").on(
      table.userId,
      table.provider,
    ),
  ],
);
export const sourceAuthorizationRequests = pgTable(
  "source_authorization_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    accountRevision: uuid("account_revision").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    purpose: text("purpose").notNull(),
    appVersion: uuid("app_version"),
    credential: jsonb("credential").$type<unknown>(),
    callbackUrl: text("callback_url").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("source_authorization_expiry").on(table.expiresAt)],
);
