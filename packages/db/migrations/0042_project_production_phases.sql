ALTER TABLE "production_database_provisions" ADD COLUMN "mode" text DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD COLUMN "effect_phase" text;--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD COLUMN "completed_phases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "production_database_provisions" ADD CONSTRAINT "production_database_provisions_connection_id_production_database_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."production_database_connections"("id") ON DELETE restrict ON UPDATE no action;