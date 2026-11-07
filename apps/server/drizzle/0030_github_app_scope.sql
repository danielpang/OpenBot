CREATE TABLE "github_state_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "repositories" jsonb;--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "repositories_synced_at" timestamp with time zone;--> statement-breakpoint
-- An App connection's reach (H1): the repositories the owner's own GitHub
-- authorization lists, with push and admin (services/git-connections.ts).
-- Used flow nonces (github_state_nonces) make the manifest, install and
-- reauthorize callbacks single use; the table is the install's, no
-- organization's, like instance_settings (0028), so it has no row-level
-- security. The grant covers installs whose tables another role made.
GRANT SELECT, INSERT, UPDATE, DELETE ON "github_state_nonces" TO openbots_app;
--> statement-breakpoint
-- 0029 let openbots_system read every column of git_connections, sealed
-- secrets among them. Its one reader, openbots_github_installation_workspaces(),
-- needs only these; the row policy system_read stays as it was.
REVOKE SELECT ON "git_connections" FROM openbots_system;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "provider", "kind", "installation_id", "created_at") ON "git_connections" TO openbots_system;
