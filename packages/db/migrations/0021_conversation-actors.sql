DROP INDEX "conversation_turns_idempotency_unique";--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN "actor_id" text;--> statement-breakpoint
-- Existing conversations were private: their owner was the submitting actor.
UPDATE "conversation_turns" AS turns
SET "actor_id" = projects."user_id"
FROM "conversations" AS conversations, "projects" AS projects
WHERE turns."conversation_id" = conversations."id" AND conversations."project_id" = projects."id";
--> statement-breakpoint
UPDATE "conversation_messages" AS messages
SET "actor_id" = turns."actor_id"
FROM "conversation_turns" AS turns
WHERE messages."turn_id" = turns."id" AND messages."role" = 'user';
--> statement-breakpoint
ALTER TABLE "conversation_turns" ALTER COLUMN "actor_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_actor_idempotency_unique" ON "conversation_turns" USING btree ("conversation_id","actor_id","idempotency_key");