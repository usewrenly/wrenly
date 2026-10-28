CREATE TABLE "preview_database_bindings" (
	"preview_id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"revision" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "preview_database_bindings" ADD CONSTRAINT "preview_database_bindings_preview_id_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_database_bindings" ADD CONSTRAINT "preview_database_bindings_resource_id_app_databases_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."app_databases"("id") ON DELETE restrict ON UPDATE no action;