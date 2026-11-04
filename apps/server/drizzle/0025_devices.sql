CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid,
	"code_hash" "bytea" NOT NULL,
	"direct_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"creates_owner" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"public_key" "bytea",
	"api_key_id" uuid,
	"push_token" "bytea",
	"push_environment" text,
	"push_key" "bytea",
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "instance_keys" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"signing_key" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_keys_one_row" CHECK ("instance_keys"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_api_key_id_apikeys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairings_workspace_owner" ON "device_pairings" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "devices_workspace_owner" ON "devices" USING btree ("workspace_id","owner_id");--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- devices and device_pairings are an organization's; their workspace_id-led
-- indexes are devices_workspace_owner and device_pairings_workspace_owner.
-- instance_keys is the install's relay identity, no organization's: the app
-- reads and writes it as it does every table (0023's default privileges, and
-- the grant below for installs whose tables another role made).
GRANT SELECT, INSERT, UPDATE, DELETE ON "devices", "device_pairings", "instance_keys" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "devices"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "device_pairings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "device_pairings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "device_pairings"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- System lookups for the functions below, read only.
GRANT SELECT ON "devices", "device_pairings" TO openbots_system;
--> statement-breakpoint
CREATE POLICY system_read ON "devices" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE POLICY system_read ON "device_pairings" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
-- The organization of an unrevoked device, by its Noise static key: the
-- relay adapter's first question about a stream.
CREATE FUNCTION openbots_device_workspace(p_key bytea) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT workspace_id FROM devices WHERE public_key = p_key AND revoked_at IS NULL $$;
--> statement-breakpoint
-- The organization of a pairing, by the SHA-256 of its code: where
-- POST /devices/pair then checks the code.
CREATE FUNCTION openbots_pairing_workspace(p_hash bytea) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT workspace_id FROM device_pairings WHERE code_hash = p_hash $$;
--> statement-breakpoint
-- Whether any organization has an unrevoked device or an open pairing: the
-- relay link dials out only then. A yes or no, nothing more.
CREATE FUNCTION openbots_devices_exist(p_now timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT FROM devices WHERE revoked_at IS NULL)
      OR EXISTS (SELECT FROM device_pairings WHERE used_at IS NULL AND expires_at > p_now)
  $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for these.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_device_workspace(bytea) OWNER TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_pairing_workspace(bytea) OWNER TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_devices_exist(timestamptz) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_device_workspace(bytea), openbots_pairing_workspace(bytea), openbots_devices_exist(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_device_workspace(bytea), openbots_pairing_workspace(bytea), openbots_devices_exist(timestamptz) TO openbots_app;
