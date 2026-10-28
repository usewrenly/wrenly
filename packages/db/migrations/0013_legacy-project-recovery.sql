CREATE TABLE "legacy_project_recovery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"source_id" text NOT NULL,
	"project_ids" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"request_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_project_recovery_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "legacy_project_recovery" ADD CONSTRAINT "legacy_project_recovery_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;