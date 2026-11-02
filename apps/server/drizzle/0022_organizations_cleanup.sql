ALTER TABLE "invites" DROP CONSTRAINT "invites_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT "invites_used_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "inviter_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "used_at";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "used_by";--> statement-breakpoint
ALTER TABLE "workspace_members" DROP COLUMN "disabled_at";--> statement-breakpoint
DROP TYPE "public"."workspace_role";