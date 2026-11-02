ALTER TYPE "public"."skill_source" ADD VALUE 'imported';--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "origin" jsonb;