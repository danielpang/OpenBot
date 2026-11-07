-- A coding session's request on the owner's own turn has no run (CA15), so
-- run_id may be null as long as session_id is set, and the row goes with
-- its session instead of losing the one link it has.
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_session_id_coding_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_session_id_coding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_or_session" CHECK ("approvals"."run_id" is not null or "approvals"."session_id" is not null);
