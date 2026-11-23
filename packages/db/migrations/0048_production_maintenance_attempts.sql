CREATE TABLE "production_runtime_maintenance_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"journal" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance_attempts" ADD CONSTRAINT "production_runtime_maintenance_attempts_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance_attempts" ADD CONSTRAINT "production_runtime_maintenance_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;