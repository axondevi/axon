# Security Policy

Axon custodies USDC and proxies API keys. Security reports are handled seriously and fast.

## Supported versions

| Version | Status |
|---------|--------|
| `main` branch (latest tag) | Supported — patched actively |
| Older tags | Not supported — upgrade |

## Reporting a vulnerability

**Do not open a public GitHub issue.**

Use GitHub's private vulnerability disclosure for this repo:
[https://github.com/axondevi/axon/security/advisories/new](https://github.com/axondevi/axon/security/advisories/new)

(Or, if email is preferred, contact the maintainer through their GitHub profile.)

Please include:
1. A description of the vulnerability
2. Steps to reproduce (ideally a minimal PoC)
3. Your assessment of impact
4. Your preferred disclosure timeline

## Response SLA

| Severity | First response | Patch |
|----------|----------------|-------|
| Critical (fund loss, auth bypass, RCE) | 24 hours | 7 days |
| High (data exposure, privilege escalation) | 48 hours | 14 days |
| Medium (DoS, information disclosure) | 5 days | 30 days |
| Low (defense-in-depth) | 10 days | next release |

## Safe harbor

Good-faith research is welcome. We will not pursue legal action if you:
1. Don't access user data beyond what's necessary to demonstrate the issue
2. Don't DoS our production infrastructure
3. Don't exploit the vulnerability beyond proof of concept
4. Report to us before public disclosure
5. Give us a reasonable window to patch before disclosing

## What we care about most

In rough order of concern:

1. **Wallet / ledger integrity.** Any path that produces a wrong balance, double-debits, or skips a refund is critical. See `docs/security.md` for the invariants. We use atomic Postgres `UPDATE WHERE balance-reserved >= amount` for debit, Redis `INCRBY` reservations for daily/monthly/per-API budgets, and a unique partial index on `transactions.onchain_tx` to prevent replay credits.
2. **x402 native isolation.** The on-chain payment middleware must not allow an attacker to trigger internal debits, and vice versa. The `/x402/v1/*` subtree is only mounted when `ENABLE_X402_NATIVE=true`.
3. **Admin surface.** Unauthorized access to `/v1/admin/*` compromises every user. `x-admin-key` comparison uses `crypto.timingSafeEqual`.
4. **Webhook signature verification.** Forged deposit webhooks would credit attacker wallets. Alchemy uses HMAC-SHA256 of the raw body. MercadoPago uses constant-time XOR comparison of the `x-signature` HMAC; in production a missing `MP_WEBHOOK_SECRET` returns 503 instead of silently accepting payloads. WhatsApp inbound has a 10-min Redis replay-guard.
5. **Privy authentication.** `/v1/auth/privy` cryptographically verifies the Privy JWT via `jose.createRemoteJWKSet` against the published JWKS, ES256-only. Issuer + audience claims enforced.
6. **Upstream key exposure.** Decryption paths for `transactions.meta.backup_enc` and upstream secrets. CDP wallet seeds are encrypted (AES-256-GCM with `MASTER_ENCRYPTION_KEY`) inside the provider before crossing module boundaries.
7. **SSRF.** `src/lib/ssrf.ts` blocks RFC1918 / loopback / link-local / 169.254 (cloud IMDS) / CGNAT / IPv6 ULA / `*.local` / `*.internal` / cloud-metadata hostnames at every place we fetch on a user-supplied URL: webhook subscribers (create-time + delivery), the `summarize_url` agent tool, WhatsApp `instance_url` registration.
8. **Multi-tenant cache leakage.** Wrapper cache keys default to per-user scope (`userId` in the hash); endpoints opt into a global LRU only via registry `cache_scope: 'shared'`.
9. **CSRF / CORS** — less critical because API key auth is stateless, but still in scope. CORS locks to `CORS_ALLOWED_ORIGINS` (csv); the default is just `https://axon-5zf.pages.dev`.

## Verification commands

To independently confirm the security gates:

```bash
# 1. CORS allows ONLY configured origins
curl -i -X OPTIONS -H "Origin: https://evil.com" \
  -H "Access-Control-Request-Method: GET" \
  https://axon-kedb.onrender.com/v1/wallet/balance
# Expect: no `access-control-allow-origin` header in response

# 2. SSRF guard rejects metadata IMDS
curl -X POST -H "X-API-Key: $AXON_KEY" -H "Content-Type: application/json" \
  -d '{"url":"http://169.254.169.254/","events":["deposit.received"]}' \
  https://axon-kedb.onrender.com/v1/webhook-subscriptions
# Expect: 400 with reason "private IPv4 169.254.169.254 blocked"

# 3. Manual deposit webhook is disabled in prod
curl -X POST -H "x-deposit-token: anything" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x0","amount_usdc":"1"}' \
  https://axon-kedb.onrender.com/v1/webhooks/manual
# Expect: 403 forbidden

# 4. MP webhook fail-closed without secret
curl -X POST -H "Content-Type: application/json" \
  -d '{"data":{"id":"fake"}}' \
  https://axon-kedb.onrender.com/v1/webhooks/mercadopago
# Expect: 503 'misconfigured' (until MP_WEBHOOK_SECRET is set)
```

## What's out of scope

- Social engineering of our support team
- Physical attacks
- Vulnerabilities in third-party services (report to them directly: Coinbase CDP, Alchemy, Neon, Render, etc.)
- Denial-of-service testing against production — use your own self-hosted instance
- Findings that require an already-compromised user device
