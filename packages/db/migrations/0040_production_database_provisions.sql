CREATE TABLE "production_database_provisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"account_revision" uuid NOT NULL,
	"access_revision" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"placement" jsonb NOT NULL,
	"secrets" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"effect_started_at" timestamp with time zone,
	"remote_uuid" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD CONSTRAINT "production_database_provisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD CONSTRAINT "production_database_provisions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_database_provision_request_unique" ON "production_database_provisions" USING btree ("actor_id","request_id");--> statement-breakpoint
CREATE INDEX "production_database_provision_project_status_idx" ON "production_database_provisions" USING btree ("project_id","status");