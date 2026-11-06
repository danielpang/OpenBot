CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"kind" text NOT NULL,
	"installation_id" text,
	"account_login" text NOT NULL,
	"account_type" text,
	"act_as" text DEFAULT 'bot' NOT NULL,
	"secrets" "bytea",
	"status" text DEFAULT 'connected' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "last_remote_push_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "found_path" text;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_connections_workspace_owner" ON "git_connections" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_connections_installation_per_owner" ON "git_connections" USING btree ("workspace_id","owner_id","provider","installation_id") WHERE "git_connections"."installation_id" is not null;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_connection_id_git_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."git_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- git_connections is an organization's; its workspace_id-led indexes are
-- git_connections_workspace_owner and git_connections_installation_per_owner
-- (unique, partial). instance_settings is the install's, no organization's,
-- like instance_keys (0025): the app reads and writes it as it does every
-- table. The grant covers installs whose tables another role made (0023's
-- default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "git_connections", "instance_settings" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "git_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "git_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "git_connections"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
