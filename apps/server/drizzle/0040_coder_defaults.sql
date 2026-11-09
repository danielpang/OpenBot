ALTER TABLE "coder_accounts" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "coder_accounts" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coding_sessions" ADD COLUMN "model" text;--> statement-breakpoint
CREATE UNIQUE INDEX "coder_accounts_owner_default" ON "coder_accounts" USING btree ("workspace_id","owner_id") WHERE "coder_accounts"."is_default";