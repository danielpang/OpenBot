CREATE TABLE "coder_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"provider_id" uuid,
	"account_label" text,
	"signed_in_at" timestamp with time zone,
	"last_error" text,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coder_accounts_owner_agent" UNIQUE("workspace_id","owner_id","agent")
);
--> statement-breakpoint
CREATE TABLE "coder_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"url" text,
	"device_code" text,
	"account_label" text,
	"error" text,
	"chat_id" uuid,
	"message_id" uuid,
	"part_index" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"run_id" uuid,
	"chat_id" uuid,
	"message_id" uuid,
	"part_index" integer,
	"agent" text NOT NULL,
	"repo_id" uuid,
	"repo_full_name" text,
	"remote_url" text,
	"worktree_path" text,
	"branch" text,
	"base" text,
	"mode" text NOT NULL,
	"prompt" text NOT NULL,
	"vendor_session_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"push_allowed" boolean DEFAULT false NOT NULL,
	"usage" jsonb,
	"summary" text,
	"changed_files" jsonb,
	"commits" jsonb,
	"pr_url" text,
	"error" text,
	"log_path" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"path" text NOT NULL,
	"state" text DEFAULT 'missing' NOT NULL,
	"ahead" integer DEFAULT 0 NOT NULL,
	"behind" integer DEFAULT 0 NOT NULL,
	"head_sha" text,
	"last_fetch_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_checkouts_repo_computer" UNIQUE("repo_id","computer_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid,
	"full_name" text NOT NULL,
	"remote_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"visibility" text,
	"description" text,
	"keep_cloned" boolean DEFAULT true NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_owner_remote" UNIQUE("workspace_id","owner_id","remote_url")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "action_class" text;--> statement-breakpoint
ALTER TABLE "coder_accounts" ADD CONSTRAINT "coder_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder_accounts" ADD CONSTRAINT "coder_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder_accounts" ADD CONSTRAINT "coder_accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder_logins" ADD CONSTRAINT "coder_logins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder_logins" ADD CONSTRAINT "coder_logins_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder_logins" ADD CONSTRAINT "coder_logins_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder_logins" ADD CONSTRAINT "coder_logins_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD CONSTRAINT "coding_sessions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_checkouts" ADD CONSTRAINT "repo_checkouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_checkouts" ADD CONSTRAINT "repo_checkouts_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_checkouts" ADD CONSTRAINT "repo_checkouts_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coder_logins_owner_agent" ON "coder_logins" USING btree ("workspace_id","owner_id","agent");--> statement-breakpoint
CREATE INDEX "coding_sessions_workspace_id_idx" ON "coding_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "coding_sessions_bot_status" ON "coding_sessions" USING btree ("bot_id","status");--> statement-breakpoint
CREATE INDEX "coding_sessions_run" ON "coding_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "repo_checkouts_workspace_id_idx" ON "repo_checkouts" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_session_id_coding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- each of these is an organization's. Their workspace_id-led indexes are
-- coder_accounts_owner_agent and repos_owner_remote (unique), and
-- repo_checkouts_workspace_id_idx, coding_sessions_workspace_id_idx and
-- coder_logins_owner_agent. The grant covers installs whose tables another
-- role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "coder_accounts", "repos", "repo_checkouts", "coding_sessions", "coder_logins" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "coder_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "coder_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "coder_accounts"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "repos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repos" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "repos"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "repo_checkouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repo_checkouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "repo_checkouts"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "coding_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "coding_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "coding_sessions"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "coder_logins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "coder_logins" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "coder_logins"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
