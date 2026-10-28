CREATE TABLE "app_database_validations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"build_id" uuid NOT NULL,
	"build_token" uuid NOT NULL,
	"access_revision" uuid NOT NULL,
	"resource_revision" uuid NOT NULL,
	"framework" text NOT NULL,
	"files" jsonb NOT NULL,
	"source_digest" text NOT NULL,
	"migration_digest" text NOT NULL,
	"image_id" text NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"schema_digest" text
);
--> statement-breakpoint
ALTER TABLE "app_database_validations" ADD CONSTRAINT "app_database_validations_operation_id_app_database_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."app_database_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_database_validations" ADD CONSTRAINT "app_database_validations_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;