ALTER TABLE "deployments" ADD COLUMN "production_database_binding" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "production_runtime_journal" jsonb;