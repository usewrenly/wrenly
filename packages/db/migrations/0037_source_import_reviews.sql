CREATE TABLE "source_import_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"connection_version" uuid NOT NULL,
	"repository" jsonb NOT NULL,
	"commit_id" text NOT NULL,
	"tree_id" text NOT NULL,
	"stack" text NOT NULL,
	"files" jsonb NOT NULL,
	"excluded_paths" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_project_origins" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"review_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"repository" jsonb NOT NULL,
	"commit_id" text NOT NULL,
	"tree_id" text NOT NULL,
	"baseline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_import_reviews" ADD CONSTRAINT "source_import_reviews_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD CONSTRAINT "source_project_origins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD CONSTRAINT "source_project_origins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD CONSTRAINT "source_project_origins_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_import_user_request" ON "source_project_origins" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_import_review_once" ON "source_project_origins" USING btree ("review_id");