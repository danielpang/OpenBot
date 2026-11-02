ALTER TABLE "event_deliveries" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "origin" text DEFAULT 'ingress' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "replay_of" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_replay_of_webhook_deliveries_id_fk" FOREIGN KEY ("replay_of") REFERENCES "public"."webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_deliveries_subscription_created" ON "event_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_received" ON "webhook_deliveries" USING btree ("endpoint_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_idempotency" ON "webhook_deliveries" USING btree ("endpoint_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_dedupe" UNIQUE("subscription_id","event","dedupe_key");