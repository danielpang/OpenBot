-- The connector policy keeps only URL and command patterns: blocking and
-- allowing catalog entries by id is gone, so those rows go before their
-- columns do.
DELETE FROM "connector_policy" WHERE "catalog_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_policy" DROP CONSTRAINT "connector_policy_workspace_id_catalog_id_unique";--> statement-breakpoint
ALTER TABLE "connector_policy" DROP CONSTRAINT "connector_policy_target";--> statement-breakpoint
ALTER TABLE "connector_policy" ALTER COLUMN "url_pattern" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_policy" DROP COLUMN "catalog_id";--> statement-breakpoint
ALTER TABLE "connector_policy" DROP COLUMN "blocked";
