ALTER TABLE "preview_access" ADD COLUMN "project_revision" uuid;
--> statement-breakpoint
UPDATE "preview_access" AS access SET "project_revision" = projects."access_revision"
FROM "previews" AS previews, "projects" AS projects
WHERE access."preview_id" = previews."id" AND previews."project_id" = projects."id";
--> statement-breakpoint
ALTER TABLE "preview_access" ALTER COLUMN "project_revision" SET NOT NULL;
