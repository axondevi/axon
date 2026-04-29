-- Pix payment lifecycle (MercadoPago).
--
-- pix_payments tracks the pending → approved/expired/cancelled lifecycle
-- of each Pix charge. When status transitions to 'approved' the user's
-- USDC wallet is credited via wallet/service.credit() — that side writes
-- the immutable transactions ledger row. This table holds the *mutable*
-- short-lived state (QR codes, polling state, MP id correlation).

CREATE TABLE IF NOT EXISTS "pix_payments" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mp_payment_id"    text NOT NULL,
  "amount_brl"       numeric(12, 2) NOT NULL,
  "amount_usdc_micro" bigint,                 -- credited amount (set when approved)
  "fx_rate_brl_per_usd" numeric(8, 4),        -- BRL per USD at credit time
  "status"           text NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired | cancelled
  "qr_code"          text,                    -- copy-paste pix string (BR Codes EMV)
  "qr_code_base64"   text,                    -- PNG image, base64 (no data: prefix)
  "ticket_url"       text,                    -- alternative public URL to render the QR
  "approved_at"      timestamp,
  "expires_at"       timestamp,
  "meta"             jsonb,
  "created_at"       timestamp NOT NULL DEFAULT NOW(),
  "updated_at"       timestamp NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "pix_mp_id_idx" ON "pix_payments" ("mp_payment_id");
CREATE INDEX IF NOT EXISTS "pix_user_idx" ON "pix_payments" ("user_id");
CREATE INDEX IF NOT EXISTS "pix_status_idx" ON "pix_payments" ("status");
CREATE INDEX IF NOT EXISTS "pix_created_idx" ON "pix_payments" ("created_at" DESC);
