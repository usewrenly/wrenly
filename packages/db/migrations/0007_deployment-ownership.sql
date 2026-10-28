CREATE TABLE "deployment_queue" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "mutation_intent" jsonb;