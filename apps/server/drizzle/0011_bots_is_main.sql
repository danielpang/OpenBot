ALTER TABLE "bots" ADD COLUMN "is_main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_one_main_per_owner" ON "bots" USING btree ("owner_id") WHERE "bots"."is_main";