ALTER TABLE "app_database_validations" ALTER COLUMN "image_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_database_validations" ADD COLUMN "owns_artifact" boolean DEFAULT false NOT NULL;