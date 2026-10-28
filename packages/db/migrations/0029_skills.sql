CREATE TABLE "project_skills" (
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "project_skills_project_id_version_id_pk" PRIMARY KEY("project_id","version_id")
);
--> statement-breakpoint
CREATE TABLE "skill_actions" (
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"revision" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_actions_actor_id_request_id_pk" PRIMARY KEY("actor_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "skill_libraries" (
	"owner_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"skill_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"document" text NOT NULL,
	"sha256" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"version_label" text,
	"license_notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"revision" uuid NOT NULL,
	"current_version_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_actions" ADD CONSTRAINT "skill_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_actions" ADD CONSTRAINT "skill_actions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_actions" ADD CONSTRAINT "skill_actions_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_libraries" ADD CONSTRAINT "skill_libraries_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_skills_position_unique" ON "project_skills" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "skill_versions_skill_created" ON "skill_versions" USING btree ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skills_owner_updated" ON "skills" USING btree ("owner_id","updated_at");