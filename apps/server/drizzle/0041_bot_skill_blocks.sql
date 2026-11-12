CREATE TABLE "bot_skill_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_skill_blocks_pair" UNIQUE("bot_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "bot_skill_blocks" ADD CONSTRAINT "bot_skill_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_skill_blocks" ADD CONSTRAINT "bot_skill_blocks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_skill_blocks" ADD CONSTRAINT "bot_skill_blocks_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_skill_blocks_skill" ON "bot_skill_blocks" USING btree ("workspace_id","skill_id");--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- bot_skill_blocks is an organization's; its workspace_id-led index is
-- bot_skill_blocks_skill. The grant covers installs whose tables another
-- role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "bot_skill_blocks" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "bot_skill_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bot_skill_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "bot_skill_blocks"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
