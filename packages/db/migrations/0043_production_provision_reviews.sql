CREATE TABLE "production_database_provision_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provision_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"account_revision" uuid NOT NULL,
	"access_revision" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"prior_completed_phases" jsonb NOT NULL,
	"effect_started_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"resumed_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD COLUMN "execution_principal" jsonb;--> statement-breakpoint
ALTER TABLE "production_database_provision_reviews" ADD CONSTRAINT "production_database_provision_reviews_provision_id_production_database_provisions_id_fk" FOREIGN KEY ("provision_id") REFERENCES "public"."production_database_provisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_database_provision_reviews" ADD CONSTRAINT "production_database_provision_reviews_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_provision_review_actor_request_unique" ON "production_database_provision_reviews" USING btree ("actor_id","request_id");