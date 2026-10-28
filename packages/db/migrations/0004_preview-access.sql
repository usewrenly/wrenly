CREATE TABLE "preview_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preview_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"auth_session_id" text,
	"grant_hash" text NOT NULL,
	"grant_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"session_hash" text,
	"session_expires_at" timestamp with time zone,
	CONSTRAINT "preview_access_grant_hash_unique" UNIQUE("grant_hash"),
	CONSTRAINT "preview_access_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
ALTER TABLE "preview_access" ADD CONSTRAINT "preview_access_preview_id_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_access" ADD CONSTRAINT "preview_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;