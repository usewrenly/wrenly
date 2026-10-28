CREATE TYPE "public"."project_access_mode" AS ENUM('private', 'selected', 'instance');--> statement-breakpoint
CREATE TYPE "public"."project_member_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TABLE "project_access_actions" (
	"request_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"request_identity" text NOT NULL,
	"previous_revision" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_actions_project_id_actor_id_request_id_pk" PRIMARY KEY("project_id","actor_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "project_member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "access_mode" "project_access_mode" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "instance_role" "project_member_role" DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "access_revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access_actions" ADD CONSTRAINT "project_access_actions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_actions" ADD CONSTRAINT "project_access_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;