CREATE TABLE "coding_session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"turn" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coding_session_events_session_seq" UNIQUE("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "coding_session_events" ADD CONSTRAINT "coding_session_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_session_events" ADD CONSTRAINT "coding_session_events_session_id_coding_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."coding_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coding_session_events_workspace_id_idx" ON "coding_session_events" USING btree ("workspace_id");--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security),
-- like coding_sessions in 0027. Its workspace_id-led index is
-- coding_session_events_workspace_id_idx. The grant covers installs whose
-- tables another role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "coding_session_events" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "coding_session_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "coding_session_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "coding_session_events"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
