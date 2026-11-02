ALTER TABLE "providers" ADD COLUMN "local" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "header_secrets" "bytea";--> statement-breakpoint
-- Endpoints added before S-12 had no address check. The ones plainly on the admin's own network
-- stay reachable: local-server presets, and base URLs naming localhost, a single-label host (a
-- compose service), a .local, .internal, .lan or .home.arpa name, an IPv6 literal, or a
-- loopback, private or link-local IPv4 literal. Headers are sealed at start-up (S-9).
UPDATE "providers" SET "local" = true
WHERE "base_url" IS NOT NULL AND (
  "preset_id" IN ('ollama', 'lmstudio', 'vllm', 'litellm')
  OR lower(substring("base_url" from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?(\[[^]]*\]|[^:/?#]+)')) ~ '^(localhost|\[.*\]|[^.]+|.*\.(local|internal|lan|home\.arpa)|127\.[0-9.]+|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+|169\.254\.[0-9.]+)$'
);
