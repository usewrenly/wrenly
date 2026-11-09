CREATE TABLE "source_push_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"account_revision" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'preflight' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"tree_id" text,
	"commit_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_push_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"access_revision" uuid NOT NULL,
	"connection_version" uuid NOT NULL,
	"repository" jsonb NOT NULL,
	"base_commit" text NOT NULL,
	"base_tree" text NOT NULL,
	"branch" text NOT NULL,
	"changes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_push_operations" ADD CONSTRAINT "source_push_operations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_operations" ADD CONSTRAINT "source_push_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_operations" ADD CONSTRAINT "source_push_operations_review_id_source_push_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."source_push_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD CONSTRAINT "source_push_reviews_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD CONSTRAINT "source_push_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD CONSTRAINT "source_push_reviews_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_push_user_request" ON "source_push_operations" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_push_review_once" ON "source_push_operations" USING btree ("review_id");