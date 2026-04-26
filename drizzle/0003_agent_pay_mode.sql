-- Owner-paid mode: agent visitors don't need their own key; the owner's
-- wallet pays for every call up to a daily budget cap.

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "pay_mode" text NOT NULL DEFAULT 'visitor',
  ADD COLUMN IF NOT EXISTS "daily_budget_micro" bigint NOT NULL DEFAULT 5000000;
