-- Initial schema for Axon v0.1. Matches src/db/schema.ts.
-- Apply with: bun run db:migrate

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text,
  "api_key_hash" text NOT NULL,
  "tier" text NOT NULL DEFAULT 'free',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_api_key_idx" ON "users" ("api_key_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");

CREATE TABLE IF NOT EXISTS "wallets" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "address" text NOT NULL UNIQUE,
  "balance_micro" bigint NOT NULL DEFAULT 0,
  "reserved_micro" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "amount_micro" bigint NOT NULL,
  "api_slug" text,
  "request_id" uuid,
  "onchain_tx" text,
  "meta" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tx_user_idx" ON "transactions" ("user_id");
CREATE INDEX IF NOT EXISTS "tx_created_idx" ON "transactions" ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "tx_onchain_idx"
  ON "transactions" ("onchain_tx") WHERE "onchain_tx" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "api_registry" (
  "slug" text PRIMARY KEY,
  "provider" text NOT NULL,
  "category" text NOT NULL,
  "base_url" text NOT NULL,
  "config" jsonb NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "api_slug" text NOT NULL,
  "endpoint" text NOT NULL,
  "cost_micro" bigint NOT NULL,
  "markup_micro" bigint NOT NULL,
  "cache_hit" boolean NOT NULL DEFAULT false,
  "latency_ms" integer,
  "status" integer,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "req_user_idx" ON "requests" ("user_id");
CREATE INDEX IF NOT EXISTS "req_api_idx" ON "requests" ("api_slug");
CREATE INDEX IF NOT EXISTS "req_created_idx" ON "requests" ("created_at");

CREATE TABLE IF NOT EXISTS "policies" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "rules" jsonb NOT NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Settlement tracking (added in round 5). See src/settlement/.
CREATE TABLE IF NOT EXISTS "settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_slug" text NOT NULL,
  "period_start" timestamp NOT NULL,
  "period_end" timestamp NOT NULL,
  "request_count" integer NOT NULL,
  "owed_micro" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'pending', -- pending | paid | reconciled
  "paid_at" timestamp,
  "paid_ref" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "settlement_api_idx" ON "settlements" ("api_slug");
CREATE INDEX IF NOT EXISTS "settlement_status_idx" ON "settlements" ("status");

-- Outbound webhook subscriptions + delivery log (added in round 10).
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "events" jsonb NOT NULL,
  "secret" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "webhook_user_idx" ON "webhook_subscriptions" ("user_id");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id" uuid NOT NULL REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_status" integer,
  "last_error" text,
  "delivered_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "webhook_delivery_sub_idx" ON "webhook_deliveries" ("subscription_id");
CREATE INDEX IF NOT EXISTS "webhook_delivery_created_idx" ON "webhook_deliveries" ("created_at");
