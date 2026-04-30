-- Affiliate revenue split (Stage A of the comissão program)
--
-- Goal: agent owners enable a per-contact payout to whoever brought a
-- new visitor in via a ?ref=<axon_user_id> link. That ref id maps to an
-- Axon user, and we credit their wallet a fixed amount the first time
-- a contact (phone/session) actually engages with the agent.
--
-- Why off-chain (DB transfer instead of smart contract): MVP. We already
-- run a prepaid USDC ledger in `wallets` + `transactions`. Crediting an
-- affiliate is just `debit(owner)` + `credit(affiliate)` in the same DB
-- transaction — atomic, reversible, $0 gas. Smart contract version
-- comes later in Stage B (marketplace) where x402 enables real-time
-- on-chain split between unrelated parties.
--
-- Two new fields on `agents`:
--   affiliate_enabled        — owner-set toggle
--   affiliate_payout_micro   — how much (in micro-USDC) the owner pays
--                              the affiliate per qualified new contact
--
-- One new field on `contact_memory`:
--   referred_by_user_id      — the Axon user who brought this contact in
--                              (set on first contact creation when ref
--                              query param is present and resolves)
--   affiliate_paid_at        — timestamp of the payout (used to make
--                              sure we never double-pay; null = pending)

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS affiliate_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS affiliate_payout_micro bigint NOT NULL DEFAULT 0;

ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS referred_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS affiliate_paid_at timestamp;

CREATE INDEX IF NOT EXISTS contact_memory_referred_by_idx
  ON contact_memory (referred_by_user_id)
  WHERE referred_by_user_id IS NOT NULL;
