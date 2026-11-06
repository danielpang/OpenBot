-- Which organizations have a connection to a GitHub App installation (I19):
-- the App's webhook (POST /api/v1/github/app/webhook) names only the
-- installation, so this is its first question; the delivery then works in
-- each organization's scope (db/scope.ts). Read only, ids only.
GRANT SELECT ON "git_connections" TO openbots_system;
--> statement-breakpoint
CREATE POLICY system_read ON "git_connections" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE FUNCTION openbots_github_installation_workspaces(p_installation text) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT workspace_id FROM git_connections
    WHERE provider = 'github' AND kind = 'app' AND installation_id = p_installation
    GROUP BY workspace_id ORDER BY min(created_at)
  $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for this one.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_github_installation_workspaces(text) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_github_installation_workspaces(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_github_installation_workspaces(text) TO openbots_app;
