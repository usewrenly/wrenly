CREATE TABLE "source_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"account_revision" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"app_version" uuid,
	"credential" jsonb,
	"callback_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_authorization_requests_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"app_version" uuid NOT NULL,
	"remote_user_id" text NOT NULL,
	"remote_login" text NOT NULL,
	"credential" jsonb,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_github_app" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"slug" text NOT NULL,
	"client_id" text NOT NULL,
	"credential" jsonb NOT NULL,
	"configured_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_import_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"connection_version" uuid NOT NULL,
	"repository" jsonb NOT NULL,
	"commit_id" text NOT NULL,
	"tree_id" text NOT NULL,
	"application_root" text DEFAULT '' NOT NULL,
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
	"application_root" text DEFAULT '' NOT NULL,
	"baseline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"application_root" text DEFAULT '' NOT NULL,
	"branch" text NOT NULL,
	"changes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_authorization_requests" ADD CONSTRAINT "source_authorization_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_authorization_requests" ADD CONSTRAINT "source_authorization_requests_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_github_app" ADD CONSTRAINT "source_github_app_configured_by_user_id_fk" FOREIGN KEY ("configured_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_import_reviews" ADD CONSTRAINT "source_import_reviews_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD CONSTRAINT "source_project_origins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD CONSTRAINT "source_project_origins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_project_origins" ADD CONSTRAINT "source_project_origins_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_operations" ADD CONSTRAINT "source_push_operations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_operations" ADD CONSTRAINT "source_push_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_operations" ADD CONSTRAINT "source_push_operations_review_id_source_push_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."source_push_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD CONSTRAINT "source_push_reviews_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD CONSTRAINT "source_push_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_push_reviews" ADD CONSTRAINT "source_push_reviews_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_authorization_expiry" ON "source_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_connection_user_provider" ON "source_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "source_import_user_request" ON "source_project_origins" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_import_review_once" ON "source_project_origins" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_push_user_request" ON "source_push_operations" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_push_review_once" ON "source_push_operations" USING btree ("review_id");