ALTER TABLE "builds" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "stack" "stack";--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "parent_build_id" uuid;