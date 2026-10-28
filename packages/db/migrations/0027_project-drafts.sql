CREATE TABLE "project_draft_actions" (
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"revision" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_draft_actions_actor_id_request_id_pk" PRIMARY KEY("actor_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "project_draft_members" (
	"draft_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "project_member_role" NOT NULL,
	CONSTRAINT "project_draft_members_draft_id_user_id_pk" PRIMARY KEY("draft_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"access_mode" "project_access_mode" DEFAULT 'private' NOT NULL,
	"instance_role" "project_member_role" DEFAULT 'viewer' NOT NULL,
	"archived_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_draft_actions" ADD CONSTRAINT "project_draft_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_draft_actions" ADD CONSTRAINT "project_draft_actions_draft_id_project_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."project_drafts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_draft_members" ADD CONSTRAINT "project_draft_members_draft_id_project_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."project_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_draft_members" ADD CONSTRAINT "project_draft_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_drafts" ADD CONSTRAINT "project_drafts_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_drafts_owner_updated" ON "project_drafts" USING btree ("owner_id","updated_at");