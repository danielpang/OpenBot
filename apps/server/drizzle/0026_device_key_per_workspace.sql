ALTER TABLE "devices" DROP CONSTRAINT "devices_public_key_unique";--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_public_key" UNIQUE("workspace_id","public_key");--> statement-breakpoint
-- One phone may pair with several organizations of one server (the managed
-- service), each its own device row with the same static key. The relay
-- adapter's lookup by static key so answers every organization that has an
-- unrevoked device with it, ordered so the first is the oldest pairing.
DROP FUNCTION openbots_device_workspace(bytea);
--> statement-breakpoint
CREATE FUNCTION openbots_device_workspaces(p_key bytea) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT workspace_id FROM devices
    WHERE public_key = p_key AND revoked_at IS NULL
    ORDER BY created_at, id
  $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_device_workspaces(bytea) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_device_workspaces(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_device_workspaces(bytea) TO openbots_app;
