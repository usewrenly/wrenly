CREATE TABLE "profile_pictures" (
	"user_id" text PRIMARY KEY NOT NULL,
	"image_base64" text,
	"revision" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"expected_revision" uuid,
	"content_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_pictures" ADD CONSTRAINT "profile_pictures_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;