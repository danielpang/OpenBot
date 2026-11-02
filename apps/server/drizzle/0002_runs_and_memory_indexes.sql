CREATE INDEX "runs_bot_status" ON "runs" USING btree ("bot_id","status");--> statement-breakpoint
CREATE INDEX "runs_chat_created" ON "runs" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_memories_bot_created" ON "bot_memories" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_memories_embedding" ON "bot_memories" USING hnsw ("embedding" vector_cosine_ops);