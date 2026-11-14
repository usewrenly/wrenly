CREATE TABLE "prompt_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"upload_request_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"project_id" uuid,
	"bound_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN "attachments_v1" jsonb DEFAULT '{"version":1,"files":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_attachments" ADD CONSTRAINT "prompt_attachments_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_attachments" ADD CONSTRAINT "prompt_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_attachments_owner_upload_unique" ON "prompt_attachments" USING btree ("owner_id","upload_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_attachments_object_unique" ON "prompt_attachments" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "prompt_attachments_owner_expiry_idx" ON "prompt_attachments" USING btree ("owner_id","expires_at");