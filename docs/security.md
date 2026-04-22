# Security

Axon custodies USDC and proxies API keys. The threat model is therefore non-trivial. This doc lists the decisions we made, what's protected by what, and what you should check before accepting real money.

## Secrets inventory

| Secret | Where it lives | Rotation |
|--------|----------------|----------|
| `MASTER_ENCRYPTION_KEY` | Env var, never logged | **Never rotate** — it decrypts upstream keys at rest. Losing it = re-enter every upstream key. Back it up in a separate secret store. |
| `ADMIN_API_KEY` | Env var | Rotate quarterly. Invalidates session for ops tools; clients don't use it. |
| `METRICS_TOKEN` | Env var (optional) | Rotate when team composition changes. |
| User API keys (`ax_live_…`) | **Hashed** (`sha256`) in DB | Users can rotate anytime (delete + recreate). We never store plaintext. |
| Upstream API keys | Encrypted AES-256-GCM at rest in `transactions.meta` or in env vars per provider | Rotate per provider policy; re-encrypt on rotation. |
| Alchemy webhook signing key | Env var | Rotate in Alchemy dashboard when compromised. |
| CDP API credentials | Env vars | Coinbase allows rotation; re-upload to Railway/Fly secrets after. |

## At-rest encryption

- **`MASTER_ENCRYPTION_KEY`** (hashed to 32 bytes via sha256) drives AES-256-GCM via `node:crypto`.
- Ciphertexts include a fresh 12-byte IV and a GCM auth tag — tampering is detected.
- `encrypt()` output shape: `{iv-hex}:{tag-hex}:{data-hex}`.
- Wallet provider backups (`serializedBackup` from CDP) are encrypted before writing to `transactions.meta.backup_enc`.

## Atomic debit guarantee

The wallet service uses a single SQL `UPDATE` with a `WHERE` on `(balance_micro - reserved_micro) >= amount`. Rows-affected of 0 means insufficient funds and we throw. No distributed locks, no race conditions, no double-spend. Covered by `wallet-providers.test.ts` and integration tests.

## Refund semantics

Every debit has a compensating credit path:
- Upstream network error → full refund
- Upstream 4xx/5xx → full refund
- Metering reconciliation shows overcharge → partial refund (amount = estimated − actual)
- x402 native mode → no debit to refund (on-chain payment only)

Refunds are recorded as `type: 'refund'` transactions with `meta.reason` set. They're auditable forever.

## x402-native path isolation

Requests to `/x402/v1/call/*` run through a separate middleware chain:
- No API key required
- Payment verified on-chain by the x402 middleware
- `ctx.x402Paid` flag skips all internal debit/refund/policy/metering
- Logged under the synthetic `X402_ANON_USER_ID` (bootstrapped at server start)

The two paths never mix. A prepaid user can't accidentally pay twice.

## Rate limiting

Redis fixed-window bucket per `(user_id, minute)`. Returns 429 with `retry-after`. The counter is approximate (fixed window, not sliding), intentional to keep latency low. Defeats simple loops, not sophisticated traffic shaping.

Per-tier defaults: free=10/min, pro=600/min, team=3000/min, enterprise=30000/min.

## Admin surface

All `/v1/admin/*` endpoints require `x-admin-key: ${ADMIN_API_KEY}`. No per-user bypass. Audit logs (request log + transactions) capture every admin action.

**Admin endpoints create/modify real money state** — restrict network access to them (VPN, internal IP allowlist, or don't expose publicly at all).

## Webhooks

`/v1/webhooks/alchemy` — HMAC-SHA256 signature verification against `ALCHEMY_WEBHOOK_SIGNING_KEY`. Replay-protected by the unique `(onchain_tx)` partial index on `transactions`.

`/v1/webhooks/manual` — fallback only. Gated by `DEPOSIT_WEBHOOK_TOKEN` and intended for testnet or manual reconciliation. Don't expose to the internet.

## CORS

Currently `*` with explicit allowed headers (`x-api-key`, `content-type`, `authorization`). Safe because API-key auth is stateless — no cookies, no CSRF vector. If you add a dashboard with cookie auth, tighten CORS to your domain.

## Input validation

- API keys: fixed format (`ax_live_[a-f0-9]{48}`)
- Admin key: constant-time compare
- Webhook signatures: constant-time compare via `timingSafeEqual`
- JSON parsing: bounded by Hono default body size
- Numeric amounts: `bigint` throughout — no floating-point precision issues
- Policy budgets: regex-validated integer strings on admin PUT

## Known limitations (v0.1)

- **Fallback routing bills at the primary's price** even if fallback is cheaper. We plan to re-price on fallback but it needs careful UX — currently a known small overcharge when fallback is used.
- **Fixed-window rate limit** (not sliding). A burst at the window boundary can briefly exceed 2× the limit.
- **No replay protection for the `x-api-key` header** beyond HTTPS. Leaked keys must be rotated by the user.
- **Custodial model** means losing the CDP seed means losing USDC. Back up seeds in a second store.

## Reporting security issues

Email `security@axon.dev` with a description. Don't open public issues. We'll respond within 24h, patch within 7d for critical, disclose within 90d.
