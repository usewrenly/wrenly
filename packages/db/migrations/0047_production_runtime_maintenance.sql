CREATE TABLE "production_runtime_maintenance" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"grant" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_runtime_maintenance_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"account_revision" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_identity" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance" ADD CONSTRAINT "production_runtime_maintenance_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance" ADD CONSTRAINT "production_runtime_maintenance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance_actions" ADD CONSTRAINT "production_runtime_maintenance_actions_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance_actions" ADD CONSTRAINT "production_runtime_maintenance_actions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runtime_maintenance_actions" ADD CONSTRAINT "production_runtime_maintenance_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_maintenance_actor_request_unique" ON "production_runtime_maintenance_actions" USING btree ("actor_id","request_id");