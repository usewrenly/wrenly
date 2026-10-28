CREATE TABLE "instance_owner_recovery" (
	"id" integer PRIMARY KEY NOT NULL,
	"target_user_id" text NOT NULL,
	"proof_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"completed_request_id" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "instance_owner_recovery_audit" (
	"request_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_owner_recovery" ADD CONSTRAINT "instance_owner_recovery_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_owner_recovery_audit" ADD CONSTRAINT "instance_owner_recovery_audit_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;