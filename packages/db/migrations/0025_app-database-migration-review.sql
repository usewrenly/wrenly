ALTER TABLE "app_database_migrations" ADD COLUMN "backup_id" uuid;--> statement-breakpoint
ALTER TABLE "app_database_migrations" ADD COLUMN "before_schema_digest" text;--> statement-breakpoint
ALTER TABLE "app_database_migrations" ADD COLUMN "rehearsed_schema_digest" text;--> statement-breakpoint
ALTER TABLE "app_database_operations" ADD COLUMN "cleanup_effect" jsonb;--> statement-breakpoint
ALTER TABLE "app_database_operations" ADD COLUMN "completed_cleanup_effects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app_database_migrations" ADD CONSTRAINT "app_database_migrations_backup_id_app_database_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."app_database_backups"("id") ON DELETE restrict ON UPDATE no action;