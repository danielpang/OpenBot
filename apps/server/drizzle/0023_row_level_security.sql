-- Row-level security between organizations: the second layer under the
-- services' own workspace_id filters (docs/SECURITY.md, "Organizations";
-- plan 21.9). The app works as openbots_app, which owns nothing and does
-- not bypass RLS; each transaction first sets app.workspace_id to its
-- organization (src/db/scope.ts). Without it, every table below returns no
-- rows and takes no writes.
--
-- openbots_auth is better-auth's role and the organization directory's: the
-- account tables and, across organizations, workspaces, memberships,
-- invitations and API keys, nothing else. openbots_system owns the narrow
-- SECURITY DEFINER functions at the end. Roles belong to the cluster, so
-- they are made only when missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openbots_app') THEN
    CREATE ROLE openbots_app NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openbots_auth') THEN
    CREATE ROLE openbots_auth NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openbots_system') THEN
    CREATE ROLE openbots_system NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
-- The app may become openbots_auth for directory work; NOINHERIT keeps that
-- role's policies off it otherwise. The migration role may become either
-- (tests, and installs with no OPENBOTS_DB_APP_PASSWORD), and owns the
-- functions through openbots_system.
GRANT openbots_auth TO openbots_app;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT openbots_app, openbots_auth, openbots_system TO %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not grant the openbots roles to %', current_user;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO openbots_app, openbots_auth, openbots_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openbots_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openbots_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openbots_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO openbots_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "sessions", "accounts", "verifications", "apikeys", "workspaces", "workspace_members", "invites" TO openbots_auth;
--> statement-breakpoint
-- Every table with workspace_id: forced RLS (the table owner too, unless a
-- superuser), one policy for reads and writes, and an index led by
-- workspace_id where none was.
DO $$
DECLARE
  t text;
  isolation text := 'workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid';
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY organization_isolation ON %I USING (%s) WITH CHECK (%s)', t, isolation, isolation);
    IF NOT EXISTS (
      SELECT FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = format('%I', t)::regclass AND a.attname = 'workspace_id'
    ) THEN
      EXECUTE format('CREATE INDEX %I ON %I (workspace_id)', t || '_workspace_id_idx', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "workspaces"
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY directory ON "workspaces" TO openbots_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY directory ON "workspace_members" TO openbots_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY directory ON "invites" TO openbots_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY directory ON "apikeys" TO openbots_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
-- System lookups, each read only and as narrow as its job.
GRANT SELECT ON "workspaces", "webhook_endpoints", "bots", "routines", "connectors" TO openbots_system;
--> statement-breakpoint
CREATE POLICY system_read ON "workspaces" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE POLICY system_read ON "webhook_endpoints" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE POLICY system_read ON "bots" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE POLICY system_read ON "routines" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE POLICY system_read ON "connectors" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
-- Every organization's id, for work that runs in each one in turn (startup
-- upkeep, sweeps, retention).
CREATE FUNCTION openbots_workspace_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT id FROM workspaces ORDER BY created_at $$;
--> statement-breakpoint
-- The organization of the webhook endpoint a path names: the Bot by id, or
-- by handle, and the endpoint's slug. At most two, so the caller can refuse
-- an ambiguous handle.
CREATE FUNCTION openbots_webhook_workspaces(p_bot text, p_slug text, p_by_id boolean) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT e.workspace_id FROM webhook_endpoints e JOIN bots b ON b.id = e.bot_id
    WHERE e.slug = p_slug
      AND CASE WHEN p_by_id THEN b.id::text = lower(p_bot) ELSE b.handle = lower(p_bot) END
    LIMIT 2
  $$;
--> statement-breakpoint
-- The organizations with a Routine due, for the scheduler to tick in each.
CREATE FUNCTION openbots_due_routine_workspaces(p_now timestamptz) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT workspace_id FROM routines
    WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= p_now
  $$;
--> statement-breakpoint
-- The organization of a connector, for the OAuth callback its state names.
CREATE FUNCTION openbots_connector_workspace(p_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT workspace_id FROM connectors WHERE id = p_id $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for these.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_workspace_ids() OWNER TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_connector_workspace(uuid) OWNER TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_due_routine_workspaces(timestamptz) OWNER TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_webhook_workspaces(text, text, boolean) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_workspace_ids(), openbots_webhook_workspaces(text, text, boolean), openbots_due_routine_workspaces(timestamptz), openbots_connector_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_workspace_ids(), openbots_webhook_workspaces(text, text, boolean), openbots_due_routine_workspaces(timestamptz), openbots_connector_workspace(uuid) TO openbots_app;
