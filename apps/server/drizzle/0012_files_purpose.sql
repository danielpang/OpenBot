CREATE TYPE "public"."file_purpose" AS ENUM('attachment', 'artifact', 'webhook_body', 'avatar');--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "purpose" "file_purpose" DEFAULT 'attachment' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_owner_purpose_created" ON "files" USING btree ("owner_id","purpose","created_at");--> statement-breakpoint
-- Every file so far was stored as an attachment. Artifact version blobs and webhook delivery
-- bodies are known by the rows that point at them. An upload is an avatar when a Bot's avatar
-- or a template's avatar names it and no message attached it (avatar uploads went through the
-- same files API).
UPDATE "files" SET "purpose" = 'artifact'
WHERE "id"::text IN (SELECT "storage_key" FROM "artifact_versions");--> statement-breakpoint
UPDATE "files" SET "purpose" = 'webhook_body'
WHERE "id"::text IN (SELECT "body_ref" FROM "webhook_deliveries" WHERE "body_ref" IS NOT NULL);--> statement-breakpoint
UPDATE "files" SET "purpose" = 'avatar'
WHERE "purpose" = 'attachment'
  AND (
    "id"::text IN (SELECT "avatar"->>'file_id' FROM "bots" WHERE "avatar"->>'kind' = 'upload')
    OR "id"::text IN (
      SELECT "snapshot"->'profile'->'avatar'->>'file_id' FROM "bot_templates"
      WHERE "snapshot"->'profile'->'avatar'->>'kind' = 'upload'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "messages"
    WHERE "messages"."parts" @> jsonb_build_array(jsonb_build_object('file_id', "files"."id"::text))
  );--> statement-breakpoint
-- An attachment's chat is the chat of the first message its owner sent it in.
UPDATE "files" SET "chat_id" = (
  SELECT "messages"."chat_id" FROM "messages"
  WHERE "messages"."author_type" = 'user'
    AND "messages"."author_id" = "files"."owner_id"
    AND "messages"."parts" @> jsonb_build_array(jsonb_build_object('file_id', "files"."id"::text))
  ORDER BY "messages"."created_at"
  LIMIT 1
)
WHERE "purpose" = 'attachment';
