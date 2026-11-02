CREATE TABLE "message_deletions" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_seq" bigint NOT NULL,
	"thread_root_id" uuid,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_deletions" ADD CONSTRAINT "message_deletions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deletions" ADD CONSTRAINT "message_deletions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_deletions_chat_seq" ON "message_deletions" USING btree ("chat_id","seq");--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security).
GRANT SELECT, INSERT, UPDATE, DELETE ON "message_deletions" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "message_deletions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_deletions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "message_deletions"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE INDEX "message_deletions_workspace_id_idx" ON "message_deletions" ("workspace_id");
