-- Add subscription columns to users table.
-- tier_expires_at NULL = no active sub (treat as free).
-- tier_auto_renew defaults true so a paid sub auto-charges next month.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "tier_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "tier_auto_renew" boolean NOT NULL DEFAULT true;

-- Index used by the daily renewal cron to find subs about to expire.
CREATE INDEX IF NOT EXISTS "users_tier_exp_idx" ON "users" ("tier_expires_at");
