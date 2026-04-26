-- WhatsApp via Evolution API: one row per agent ↔ Evolution-instance pairing.

CREATE TABLE IF NOT EXISTS "whatsapp_connections" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"       uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "owner_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "instance_url"   text NOT NULL,
  "instance_name"  text NOT NULL,
  "api_key"        text NOT NULL,
  "webhook_secret" text NOT NULL,
  "status"         text NOT NULL DEFAULT 'connected',
  "last_event_at"  timestamp,
  "created_at"     timestamp NOT NULL DEFAULT NOW(),
  "updated_at"     timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "wa_agent_idx" ON "whatsapp_connections" ("agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "wa_secret_idx" ON "whatsapp_connections" ("webhook_secret");
