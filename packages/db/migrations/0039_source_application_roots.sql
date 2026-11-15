ALTER TABLE "source_import_reviews" ADD COLUMN "application_root" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD COLUMN "application_root" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD COLUMN "application_root" text DEFAULT '' NOT NULL;