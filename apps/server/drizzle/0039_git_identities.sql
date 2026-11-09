CREATE TABLE "git_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"commit_as" text DEFAULT 'bot' NOT NULL,
	"name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_identities" ADD CONSTRAINT "git_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_identities" ADD CONSTRAINT "git_identities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_identities_owner" ON "git_identities" USING btree ("workspace_id","owner_id");--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- git_identities is an organization's; its workspace_id-led index is
-- git_identities_owner (unique). The grant covers installs whose tables
-- another role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "git_identities" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "git_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "git_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "git_identities"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
