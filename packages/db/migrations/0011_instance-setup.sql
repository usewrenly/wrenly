CREATE TABLE "instance_setup" (
	"id" integer PRIMARY KEY NOT NULL,
	"owner_id" text,
	"proof_hash" text,
	"proof_expires_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"completed_request_id" text,
	"completed_email" text,
	"initialized_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_setup" ADD CONSTRAINT "instance_setup_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;