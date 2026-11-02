ALTER TABLE "bots" DROP CONSTRAINT "bots_template_id_bot_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "template_id";--> statement-breakpoint
DROP TABLE "bot_templates";--> statement-breakpoint
DROP TYPE "public"."template_visibility";--> statement-breakpoint
-- Hand-added: the public template links setting is gone too.
UPDATE "workspaces" SET "settings" = "settings" - 'publicTemplatesEnabled' WHERE "settings" ? 'publicTemplatesEnabled';
