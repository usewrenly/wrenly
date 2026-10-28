CREATE TABLE "instance_model_default" (
	"id" integer PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connection_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"protocol" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text NOT NULL,
	"catalog_provider_id" text,
	"env_source_id" text,
	"credential" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_env_source_id_unique" UNIQUE("env_source_id")
);
--> statement-breakpoint
ALTER TABLE "instance_model_default" ADD CONSTRAINT "instance_model_default_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_audit" ADD CONSTRAINT "provider_connection_audit_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_audit" ADD CONSTRAINT "provider_connection_audit_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;