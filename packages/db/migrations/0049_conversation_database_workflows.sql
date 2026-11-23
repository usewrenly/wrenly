CREATE TABLE "conversation_database_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"access_revision" uuid NOT NULL,
	"prompt" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"principal" jsonb,
	"expires_at" timestamp with time zone,
	"resource_id" uuid,
	"resource_revision" uuid,
	"operation" jsonb,
	"operation_id" uuid,
	"build_id" uuid,
	"build_request_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"review" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_database_workflows" ADD CONSTRAINT "conversation_database_workflows_turn_id_conversation_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_database_workflows" ADD CONSTRAINT "conversation_database_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_database_turn_unique" ON "conversation_database_workflows" USING btree ("turn_id");