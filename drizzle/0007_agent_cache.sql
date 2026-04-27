-- Knowledge Cache: stores semantic Q/A pairs per agent.
-- New queries are checked for cosine similarity against past entries.
-- High-similarity matches (>=0.85) return cached answer at zero LLM cost.
--
-- Embedding stored as jsonb (number[]). For >50k entries we'd want pgvector
-- + ivfflat, but for v1 (<500 entries/agent) the app-layer cosine compute
-- runs in <30ms.

CREATE TABLE IF NOT EXISTS "agent_cache" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"           uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "query_text"         text NOT NULL,
  "query_embedding"    jsonb NOT NULL,
  "response_text"      text NOT NULL,
  "hits"               integer NOT NULL DEFAULT 0,
  "last_hit"           timestamp NOT NULL DEFAULT NOW(),
  "cost_saved_micro"   bigint NOT NULL DEFAULT 0,
  "created_at"         timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "agent_cache_agent_idx" ON "agent_cache" ("agent_id");
CREATE INDEX IF NOT EXISTS "agent_cache_lasthit_idx" ON "agent_cache" ("last_hit" DESC);
