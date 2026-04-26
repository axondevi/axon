-- Round 6 of agent factory: A/B testing, tier gating, vanity domains,
-- conversation logging, multi-language UI.

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "tier_required"    text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "system_prompt_b"  text,
  ADD COLUMN IF NOT EXISTS "ab_split"         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "vanity_domain"    text,
  ADD COLUMN IF NOT EXISTS "ui_language"      text NOT NULL DEFAULT 'auto';

CREATE UNIQUE INDEX IF NOT EXISTS "agents_vanity_idx"
  ON "agents" ("vanity_domain")
  WHERE "vanity_domain" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "agent_messages" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"   uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "session_id" text,
  "role"       text NOT NULL,
  "content"    text NOT NULL,
  "variant"    text,
  "visitor_ip" text,
  "created_at" timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "agent_msg_agent_idx"   ON "agent_messages" ("agent_id");
CREATE INDEX IF NOT EXISTS "agent_msg_session_idx" ON "agent_messages" ("session_id");
CREATE INDEX IF NOT EXISTS "agent_msg_created_idx" ON "agent_messages" ("created_at");
