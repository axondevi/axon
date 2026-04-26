-- Custom-agent factory: each row is one configured chat agent
-- (system prompt + allowed tools + branding + budget caps).

CREATE TABLE IF NOT EXISTS "agents" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"                 uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "slug"                     text NOT NULL,
  "name"                     text NOT NULL,
  "description"              text,
  "system_prompt"            text NOT NULL,
  "allowed_tools"            jsonb NOT NULL,
  "primary_color"            text DEFAULT '#7c5cff',
  "welcome_message"          text,
  "quick_prompts"            jsonb,
  "budget_per_session_micro" bigint NOT NULL DEFAULT 500000,
  "hard_cap_micro"           bigint NOT NULL DEFAULT 2000000,
  "public"                   boolean NOT NULL DEFAULT true,
  "template"                 text,
  "created_at"               timestamp NOT NULL DEFAULT NOW(),
  "updated_at"               timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "agents_owner_idx" ON "agents" ("owner_id");
CREATE UNIQUE INDEX IF NOT EXISTS "agents_slug_idx" ON "agents" ("slug");
