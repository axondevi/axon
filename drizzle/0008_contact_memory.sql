-- Contact Memory: durable per-contact profile + facts for WhatsApp/runner agents.
-- Keyed by (agent_id, phone). Captures structured profile data and durable
-- facts extracted from conversations. The agent loads this BEFORE each
-- response so it remembers the contact across sessions.
--
-- Why a dedicated table (vs reusing agent_messages):
--   - agent_messages is raw transcript; expensive to re-distill on every turn
--   - facts get LLM-extracted async (fire-and-forget) and merged in
--   - owner can manually edit/correct memory via dashboard
--   - small (~1 row per contact), fast lookup by (agent_id, phone)

CREATE TABLE IF NOT EXISTS "contact_memory" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"           uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "phone"              text NOT NULL,

  -- Owner-editable profile
  "display_name"       text,
  "language"           text NOT NULL DEFAULT 'pt-br',
  "formality"          text NOT NULL DEFAULT 'auto',
  "tags"               jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- LLM-extracted durable facts (array of {key, value, confidence, extracted_at})
  "facts"              jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Rolling summary for long-history compression (>20 turns)
  "summary"            text,

  -- Stats
  "message_count"      integer NOT NULL DEFAULT 0,
  "first_contact_at"   timestamp NOT NULL DEFAULT NOW(),
  "last_contact_at"    timestamp NOT NULL DEFAULT NOW(),

  "created_at"         timestamp NOT NULL DEFAULT NOW(),
  "updated_at"         timestamp NOT NULL DEFAULT NOW(),

  CONSTRAINT "contact_memory_agent_phone_unique" UNIQUE ("agent_id", "phone")
);

CREATE INDEX IF NOT EXISTS "contact_memory_agent_idx" ON "contact_memory" ("agent_id");
CREATE INDEX IF NOT EXISTS "contact_memory_last_contact_idx" ON "contact_memory" ("last_contact_at" DESC);
