-- Personas: AI characters with distinct voices and personalities.
--
-- Pattern: Agente = (Função/Tools — universal) × (Persona — única e icônica).
-- Owners pick a persona at agent creation; the agent's system prompt gets
-- the persona.prompt_fragment prepended, and TTS replies use the voice_id
-- specific to that persona. Same business config, totally different vibe.

CREATE TABLE IF NOT EXISTS "personas" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"                     text NOT NULL,
  "name"                     text NOT NULL,
  "tagline"                  text,
  "emoji"                    text,
  "tone_description"         text NOT NULL,
  "prompt_fragment"          text NOT NULL,
  "sample_greeting"          text,
  "sample_signoff"           text,
  "voice_id_elevenlabs"      text,
  "avatar_color_primary"     text NOT NULL DEFAULT '#7c5cff',
  "avatar_color_secondary"   text NOT NULL DEFAULT '#19d5c6',
  "premium"                  boolean NOT NULL DEFAULT false,
  "monthly_price_brl"        integer NOT NULL DEFAULT 0,
  "active"                   boolean NOT NULL DEFAULT true,
  "display_order"            integer NOT NULL DEFAULT 100,
  "created_at"               timestamp NOT NULL DEFAULT NOW(),
  "updated_at"               timestamp NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "personas_slug_idx" ON "personas" ("slug");
CREATE INDEX IF NOT EXISTS "personas_active_idx" ON "personas" ("active");
CREATE INDEX IF NOT EXISTS "personas_order_idx" ON "personas" ("display_order");

-- Agents reference a persona (nullable — null = no persona, default behavior).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "persona_id" uuid REFERENCES "personas"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "agents_persona_idx" ON "agents" ("persona_id");
