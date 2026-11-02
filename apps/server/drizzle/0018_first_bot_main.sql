-- K8: a member's first Bot is their main Bot. A member who has Bots but no main Bot gets their
-- earliest-created visible one (not hidden, not archived). The partial unique index still
-- allows one per owner, and DISTINCT ON picks one.
UPDATE "bots" SET "is_main" = true
WHERE "id" IN (
  SELECT DISTINCT ON ("owner_id") "id" FROM "bots" AS "candidate"
  WHERE NOT "hidden" AND "archived_at" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "bots" AS "main"
      WHERE "main"."owner_id" = "candidate"."owner_id" AND "main"."is_main"
    )
  ORDER BY "owner_id", "created_at", "id"
);
