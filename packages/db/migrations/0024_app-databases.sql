CREATE TYPE "public"."app_database_environment" AS ENUM('development', 'production');--> statement-breakpoint
CREATE TYPE "public"."app_database_operation_status" AS ENUM('queued', 'running', 'success', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."app_database_status" AS ENUM('provisioning', 'ready', 'stopped', 'failed', 'recovery_required');--> statement-breakpoint
CREATE TABLE "app_database_backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"database_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"schema_digest" text,
	"sha256" text NOT NULL,
	"encrypted_path" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_database_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_database_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"database_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"kind" text NOT NULL,
	"status" "app_database_operation_status" DEFAULT 'queued' NOT NULL,
	"expected_revision" uuid,
	"build_id" uuid,
	"migration_digest" text,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"effect" jsonb,
	"completed_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_database_queue" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_databases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "app_database_environment" NOT NULL,
	"provider" text NOT NULL,
	"status" "app_database_status" DEFAULT 'provisioning' NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"secrets" jsonb NOT NULL,
	"runtime_identity" jsonb,
	"provider_identity" jsonb,
	"schema_digest" text,
	"error_code" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_database_backups" ADD CONSTRAINT "app_database_backups_database_id_app_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."app_databases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_backups" ADD CONSTRAINT "app_database_backups_operation_id_app_database_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."app_database_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_migrations" ADD CONSTRAINT "app_database_migrations_database_id_app_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."app_databases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_migrations" ADD CONSTRAINT "app_database_migrations_operation_id_app_database_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."app_database_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_migrations" ADD CONSTRAINT "app_database_migrations_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_operations" ADD CONSTRAINT "app_database_operations_database_id_app_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."app_databases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_operations" ADD CONSTRAINT "app_database_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_operations" ADD CONSTRAINT "app_database_operations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_operations" ADD CONSTRAINT "app_database_operations_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_databases" ADD CONSTRAINT "app_databases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_databases" ADD CONSTRAINT "app_databases_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_database_operations_actor_request_unique" ON "app_database_operations" USING btree ("actor_id","request_id");--> statement-breakpoint
CREATE INDEX "app_database_operations_pending_index" ON "app_database_operations" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_databases_project_environment_unique" ON "app_databases" USING btree ("project_id","environment");