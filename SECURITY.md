# Security Policy

Axon custodies USDC and proxies API keys. Security reports are handled seriously and fast.

## Supported versions

| Version | Status |
|---------|--------|
| `main` branch (latest tag) | Supported — patched actively |
| Older tags | Not supported — upgrade |

## Reporting a vulnerability

**Do not open a public GitHub issue.**

Email: `security@axon.dev`

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

1. **Wallet / ledger integrity.** Any path that produces a wrong balance, double-debits, or skips a refund is critical. See `docs/security.md` for the invariants.
2. **x402 native isolation.** The on-chain payment middleware must not allow an attacker to trigger internal debits, and vice versa.
3. **Admin surface.** Unauthorized access to `/v1/admin/*` compromises every user.
4. **Webhook signature verification.** Forged deposit webhooks would credit attacker wallets.
5. **Upstream key exposure.** Decryption paths for `transactions.meta.backup_enc` and upstream secrets.
6. **CSRF / CORS** — less critical because API key auth is stateless, but still in scope.

## What's out of scope

- Social engineering of our support team
- Physical attacks
- Vulnerabilities in third-party services (report to them directly: Coinbase CDP, Alchemy, Neon, Render, etc.)
- Denial-of-service testing against production — use your own self-hosted instance
- Findings that require an already-compromised user device
