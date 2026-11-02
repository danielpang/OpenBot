ALTER TABLE "routine_runs" ADD COLUMN "reason" text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "slot" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "routine_runs_routine_started" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
CREATE INDEX "routines_due" ON "routines" USING btree ("next_run_at") WHERE "routines"."enabled" and "routines"."next_run_at" is not null;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_slot" UNIQUE("routine_id","slot");