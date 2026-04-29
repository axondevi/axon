-- Owner phone for WhatsApp owner-mode detection.
-- When the agent's owner messages the WhatsApp number from this phone,
-- the agent switches to a personal-assistant persona (vs. the public persona
-- shown to customers). Stored as digits only (e.g. "5511995432538").

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "owner_phone" text;
CREATE INDEX IF NOT EXISTS "agents_owner_phone_idx" ON "agents" ("owner_phone");
