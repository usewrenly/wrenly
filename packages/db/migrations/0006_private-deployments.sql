CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'preparing', 'deploying', 'verifying', 'success', 'failed', 'interrupted', 'cancelled');--> statement-breakpoint
CREATE TABLE "deployment_resources" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"git_instance_url" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"repository_id" text,
	"git_deploy_key_id" text,
	"encrypted_deploy_private_key" jsonb,
	"coolify_instance_url" text NOT NULL,
	"coolify_project_uuid" text NOT NULL,
	"coolify_server_uuid" text NOT NULL,
	"coolify_environment_name" text NOT NULL,
	"coolify_private_key_uuid" text,
	"coolify_application_uuid" text,
	"encrypted_laravel_app_key" jsonb,
	"encrypted_runtime_environment" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"stack" "stack" NOT NULL,
	"files" jsonb NOT NULL,
	"source_sha256" text NOT NULL,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"git_commit_sha" text,
	"remote_deployment_uuid" text,
	"url" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deployment_resources" ADD CONSTRAINT "deployment_resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_deployment_resources_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."deployment_resources"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_user_idempotency_unique" ON "deployments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "deployments_project_created_index" ON "deployments" USING btree ("project_id","created_at");