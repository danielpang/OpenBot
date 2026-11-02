-- A Skill is now a name and markdown content, stored in "body_md". That column
-- already holds the sections under their headings (and an imported Skill's
-- reference files) after a "# Name" title; the title goes, since the name is
-- its own field. "sections" and "status" stay, nullable, so nothing is lost.
-- An imported Skill's reference files were framed as data, not instructions;
-- as content they would read as instructions, so they go (the import can be
-- run again). The enum value is compared as text, since 0017 adds it in the
-- same transaction.
UPDATE "skills" SET "body_md" = regexp_replace("body_md", '^# [^\n]*\n*', '');--> statement-breakpoint
UPDATE "skills" SET "body_md" = regexp_replace("body_md", '(^|\n+)## Reference files(\n.*)?$', '') WHERE "source"::text = 'imported';--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "sections" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "status" DROP NOT NULL;
