CREATE TABLE "preview_database_runtime" (
	"preview_id" uuid PRIMARY KEY NOT NULL,
	"effect" jsonb,
	"completed_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_id" text,
	"socket" jsonb,
	"cleanup_effect" jsonb,
	"completed_cleanup_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup_token" uuid,
	"cleanup_lease_expires_at" timestamp with time zone,
	"cleanup_deadline_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "preview_database_runtime" ADD CONSTRAINT "preview_database_runtime_preview_id_preview_database_bindings_preview_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."preview_database_bindings"("preview_id") ON DELETE cascade ON UPDATE no action;