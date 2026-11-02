ALTER TABLE "messages" ADD COLUMN "updated_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_chat_updated_seq" ON "messages" USING btree ("chat_id","updated_seq");--> statement-breakpoint
-- Every message so far last changed, as far as resync knows, when it was inserted.
UPDATE "messages" SET "updated_seq" = "seq";--> statement-breakpoint
-- The next seq of a chat, as nextSeq() takes it: the update row-locks the chat until the
-- transaction ends, so changes to one chat commit in seq order and resync misses none.
CREATE FUNCTION "openbots_next_chat_seq"(chat uuid) RETURNS bigint LANGUAGE sql AS $$
  UPDATE "chats" SET "chat_seq" = "chat_seq" + 1 WHERE "id" = chat RETURNING "chat_seq"
$$;--> statement-breakpoint
-- A message changes for a reader when it is inserted, completes or fails, or its mentions
-- change. A flush while it streams does not count: its deltas are live, and completing
-- takes a new seq. An explicit "updated_seq" (from the triggers below) is kept.
CREATE FUNCTION "openbots_messages_updated_seq"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."updated_seq" := NEW."seq";
  ELSIF NEW."updated_seq" IS NOT DISTINCT FROM OLD."updated_seq"
    AND NOT (OLD."status" = 'streaming' AND NEW."status" = 'streaming') THEN
    NEW."updated_seq" := "openbots_next_chat_seq"(NEW."chat_id");
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "messages_updated_seq" BEFORE INSERT OR UPDATE ON "messages"
FOR EACH ROW EXECUTE FUNCTION "openbots_messages_updated_seq"();--> statement-breakpoint
-- A widget state or a reaction is part of its message as a reader sees it.
CREATE FUNCTION "openbots_touch_message"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  message uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."message_id" ELSE NEW."message_id" END;
BEGIN
  UPDATE "messages" SET "updated_seq" = "openbots_next_chat_seq"("chat_id") WHERE "id" = message;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "widget_states_touch_message" AFTER INSERT OR UPDATE OR DELETE ON "widget_states"
FOR EACH ROW EXECUTE FUNCTION "openbots_touch_message"();--> statement-breakpoint
CREATE TRIGGER "reactions_touch_message" AFTER INSERT OR UPDATE OR DELETE ON "reactions"
FOR EACH ROW EXECUTE FUNCTION "openbots_touch_message"();
