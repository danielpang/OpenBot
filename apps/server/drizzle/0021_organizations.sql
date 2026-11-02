ALTER TABLE "invites" DROP CONSTRAINT "invites_token_hash_unique";--> statement-breakpoint
ALTER TABLE "bots" DROP CONSTRAINT "bots_workspace_id_handle_unique";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_owner_id_slug_unique";--> statement-breakpoint
ALTER TABLE "computers" DROP CONSTRAINT "computers_owner_id_unique";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_owner_id_slug_unique";--> statement-breakpoint
DROP INDEX "bots_one_main_per_owner";--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "apikeys" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "inviter_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "apikeys" ADD CONSTRAINT "apikeys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_workspaces_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_workspace_id_index" ON "invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invites_email_index" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_index" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bots_one_main_per_owner" ON "bots" USING btree ("workspace_id","owner_id") WHERE "bots"."is_main";--> statement-breakpoint
-- Organizations (plan 21.1). The one workspace of an install becomes an organization:
-- its slug comes from its name and id.
UPDATE "workspaces" SET "slug" = coalesce(nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'org')
  || '-' || substr(replace("id"::text, '-', ''), 1, 8);--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_unique" UNIQUE("slug");--> statement-breakpoint
-- The earliest admin of each workspace is its owner (on a self-hosted install, the owner).
UPDATE "workspace_members" SET "role" = 'owner'
WHERE "id" IN (
  SELECT DISTINCT ON ("workspace_id") "id" FROM "workspace_members"
  WHERE "role" = 'admin'
  ORDER BY "workspace_id", "created_at", "id"
);--> statement-breakpoint
-- A disabled member is suspended in their organization.
UPDATE "workspace_members" SET "suspended_at" = "disabled_at";--> statement-breakpoint
-- Invitations are for one email address and need their inviter (better-auth's invitation).
DELETE FROM "invites" WHERE "email" IS NULL OR "created_by" IS NULL;--> statement-breakpoint
UPDATE "invites" SET "inviter_id" = "created_by",
  "status" = CASE WHEN "used_at" IS NOT NULL THEN 'accepted' ELSE 'pending' END;--> statement-breakpoint
-- Sessions and API keys work in the organization their user belongs to.
UPDATE "sessions" SET "active_organization_id" = "member"."workspace_id"
FROM (
  SELECT DISTINCT ON ("user_id") "user_id", "workspace_id" FROM "workspace_members"
  ORDER BY "user_id", "created_at", "id"
) AS "member"
WHERE "member"."user_id" = "sessions"."user_id";--> statement-breakpoint
UPDATE "apikeys" SET "workspace_id" = "member"."workspace_id"
FROM (
  SELECT DISTINCT ON ("user_id") "user_id", "workspace_id" FROM "workspace_members"
  ORDER BY "user_id", "created_at", "id"
) AS "member"
WHERE "member"."user_id" = "apikeys"."reference_id";--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_handle_per_owner" UNIQUE("workspace_id","owner_id","handle");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_slug_per_owner" UNIQUE("workspace_id","owner_id","slug");--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_one_per_owner" UNIQUE("workspace_id","owner_id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_slug_per_owner" UNIQUE("workspace_id","owner_id","slug");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_role" CHECK ("invites"."role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_status" CHECK ("invites"."status" in ('pending', 'accepted', 'rejected', 'canceled'));--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role" CHECK ("workspace_members"."role" in ('owner', 'admin', 'member'));