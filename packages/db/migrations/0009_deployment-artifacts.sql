ALTER TABLE "deployments" ADD COLUMN "artifact_image_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "artifact_base_image_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "artifact_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "registry_repository" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "registry_digest" text;