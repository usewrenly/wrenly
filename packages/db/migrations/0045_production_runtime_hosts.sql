CREATE TABLE "production_runtime_hosts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"previous_id" uuid,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"account_revision" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"server_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"secret" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"pinned_addresses" jsonb,
	"verified" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_runtime_hosts" ADD CONSTRAINT "production_runtime_hosts_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_runtime_host_request_unique" ON "production_runtime_hosts" USING btree ("actor_id","request_id");