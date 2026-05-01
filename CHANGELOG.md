# Changelog

All notable changes to Axon are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org).

Unreleased changes appear at the top. When we cut a release, they move under a dated version header.

## [Unreleased]

### Added — security & robustness sweep (Wave 1–7 + Pro 1–6, 2026-05-01)

- `src/lib/ssrf.ts` — `checkUrlSafe()` blocks RFC1918 / loopback / link-local / 169.254 (cloud IMDS) / CGNAT / IPv6 ULA / `*.local` / `*.internal` / `metadata.{aws,google}.internal`. Wired into webhook subscriber URLs, the `summarize_url` agent tool, and the WhatsApp `instance_url` registration. **16 new test cases** in `src/tests/ssrf.test.ts`.
- `src/middleware/public-rate-limit.ts` — IP-keyed rate limiter for public catalog (`/v1/apis/*`, `/v1/stats/*`) at 120/min and asset routes (`/agent-meta/*`, `/v1/personas/*`) at 240/min. Fail-closed in prod on Redis outage.
- `src/lib/logger.ts` — `redactPhone()` and `redactEmail()` helpers; applied to email send paths and signup failure logs. **9 new test cases** in `src/tests/redact.test.ts`.
- `src/policy/engine.ts` — `releaseBudget()` releases Redis budget reservations on refund.
- Privy JWT verification via `jose.createRemoteJWKSet` against the Privy JWKS endpoint (ES256-only). Added `jose` dependency.
- `src/payment/mercadopago.ts` — `isMpConfigured()` helper for silent-skip in tools.
- Pix dedupe: `POST /v1/checkout/pix` returns the existing pending QR when one is still fresh, instead of stacking duplicates.
- Settlement now uses `INSERT ... ON CONFLICT DO UPDATE` against a new unique index on `(api_slug, period_start, period_end)`. Added in bootstrap as migration 0017.
- Bootstrap migrations 0014, 0015, 0016 self-applied via `ensureCriticalSchema` (paused_at, business_info, requests.agent_id FK with orphan cleanup, whatsapp_connections.owner_id index).
- Database migrations FK on `requests.agent_id` (`ON DELETE SET NULL`) — orphan rows null'ed first.
- `src/middleware/rate-limit.ts` — fail-closed on Redis outage in production (returns 503 + retry-after).
- `src/wallet/service.ts` — `credit()` now writes the ledger row first when `onchain_tx` is supplied; replays return idempotent.
- WhatsApp inbound webhook dedupes by Evolution message id for 10 min in Redis (`ignored:replay`).
- Subscription `subscribe()` serializes per (user, tier) via Redis `SET NX` to prevent double-charge from concurrent click.
- Tool selector caps at 3 tools per turn, ranked by uniqueness × match length.
- NFT mint serialized through a per-process promise queue (no nonce contention) + `ownerOf` preflight returns idempotent for already-minted tokens.
- CDP wallet provider encrypts the exported seed inside the provider (`MASTER_ENCRYPTION_KEY` AES-256-GCM); routes persist as opaque blob.
- Cache key now defaults to per-user scope (`userId` in the hash); endpoints opt into a global cache via registry `cache_scope: 'shared'`. **3 new test cases** in `src/tests/cache-key.test.ts`.
- ESLint + Prettier + `.gitattributes` (LF normalization). New scripts: `lint`, `lint:fix`, `format`, `format:check`, `verify` (typecheck + lint + test). CI runs `verify` + `build`.
- `openapi.yaml` expanded from 18 paths to 46 paths covering Agents CRUD, Personas, Subscription, Checkout/Pix, Affiliate, Auth/Privy, Webhooks, Preview chat, NFT metadata. 17 schemas total.

### Changed

- **Breaking (self-host):** Dockerfile bumped to `oven/bun:1.3-alpine` (was `1.1-alpine`). `package.json` `engines.bun` is now `>=1.2.0`. The shipped `bun.lock` is the text-format introduced in Bun 1.2; old image versions can't parse it.
- **Breaking (security):** MercadoPago HMAC verification now uses constant-time XOR comparison (was `===` short-circuit, leaking position via timing). MP webhook fail-closed when `MP_WEBHOOK_SECRET` is unset in production (returns 503 instead of silently accepting).
- **Breaking (security):** `/v1/webhooks/manual` is fully disabled in production — set token bypassed previous gate.
- **Breaking (security):** TURN-K-EY type narrowing — `wallet` is correctly optional; explicit narrowing at the callsite. Removed `as any` casts on Hono context vars; added typed `'axon:agent_id'` and `request_id` to `ContextVariableMap`.
- API URL across SDKs/openapi/MCP/curl/n8n/landing/admin updated from non-resolving `https://api.axon.dev` to `https://axon-kedb.onrender.com` (34 occurrences in 23 files). The `evolution-api-feirinha.onrender.com` placeholder leaked into `landing/whatsapp.html` was replaced with a generic example.
- `src/index.ts` — `/v1/webhooks` mount moved BEFORE the authed `/v1` sub-router so the apiKeyAuth middleware doesn't shadow the public webhook handlers (Alchemy / MercadoPago / manual).
- `GET /v1/agents/:id` accepts both UUID and slug (was 500 on slug because Postgres rejected non-UUID input on `eq(agents.id, ...)`); same fix in PATCH/DELETE/analytics/cache-stats/messages.
- Operator `/reset-signup-limit` uses Redis `SCAN` instead of `KEYS` (O(N) blocking).
- Prometheus metrics `axon_wallet_balance_micro` label is now `user_hash` (sha256 truncated to 12) instead of raw UUID.
- `app.all('/v1/call/:slug/:endpoint{.+}')` accepts multi-segment endpoint keys for OpenAI-compat path style.
- `POST /v1/agents` caps every free-text field server-side (system_prompt 8k, description 1k, welcome 500, quick_prompt 200, allowed_tools 64×80).
- Privy JWT verifier locked to ES256; verifies issuer/audience claims; `/users/me` is a data fetch only after signature passes.
- Vision (`contextHint`) and contact-memory extractor sanitize attacker-controlled input — strips quotes/newlines from `contextHint`, replaces `"""` in user messages, drops extracted facts whose key matches a forbidden pattern (`admin`, `tier`, `role`, `api_key`, etc).
- Production config booting: `TREASURY_ADDRESS=0x000…` and `WALLET_PROVIDER=placeholder` log loud warnings (not hard-fail) so existing deploys don't crash-loop on the new asserts; only fail-closed when the affected feature is live (`ENABLE_X402_NATIVE` for treasury, `cdp/turnkey` for credentials).

### Fixed

- `routes/agents.ts` — duplicated `persona_id` block in PATCH was silently overwriting the first apply when both keys came in; removed.
- Dockerfile glob `bun.lockb*` didn't match the text-format `bun.lock`; updated to `bun.lock*`. Frozen-lockfile installs now actually work.
- `bun.lock` was untracked; committed.
- `contracts/AxonAgent.compiled.json` and the compile-and-deploy script were untracked; committed.
- `src/agents/runtime.ts:937` — the inferred union from `def.buildRequest` didn't expose `body` on the fallback branch; explicit type annotation.
- `src/wallet/providers-cdp.ts` — error thrown on dynamic-import failure now preserves `cause` for triage.

### Security

- AxonAgent.sol production-grade (mainnet-ready): real `IERC721Receiver` check on `safeTransferFrom`, `Pausable` (separate `pauser` role), `ReentrancyGuard`, two-step ownership transfer, post-mint `setTokenURI` (minter-only) for IPFS pin migration, inlined `IERC721Receiver` interface (no OZ node_modules dep on solc-only build).
- WhatsApp inbound webhook gets a 10-minute replay window via Redis `SET NX` on the Evolution message id (or body hash if missing).
- `POST /v1/webhook-subscriptions` blocks SSRF at create time AND at delivery (`webhooks/emitter.ts`).
- Operator `/v1/admin/operator/reset-signup-limit` uses `SCAN` not `KEYS`.

### Pre-existing (kept for context)

- Landing favicon (brand gradient SVG) + 1200×630 OG share image.
- `og:type`, `og:image`, `og:url`, Twitter card meta on index/stats/status.
- Accessible label on the waitlist email input (WCAG 2.1 A compliance).
- `CORS_ALLOWED_ORIGINS` env var (csv) — replaces the former `origin: '*'`.
- `METRICS_TOKEN` env var, now mandatory in production (validated at boot).

### Changed
- **Breaking (self-host):** the `/metrics` endpoint now requires `Authorization: Bearer $METRICS_TOKEN` unconditionally. Set the var before deploying.
- **Breaking (self-host):** CORS defaults to `https://axon-5zf.pages.dev` only. Add your own frontend to `CORS_ALLOWED_ORIGINS` (csv) before deploying.
- `/x402/v1/*` subtree is only mounted when `ENABLE_X402_NATIVE=true`. Hitting it with the flag off now returns `404` instead of falling through to the call engine with an implicit anon user.
- `ADMIN_API_KEY` comparison uses `crypto.timingSafeEqual` (timing-safe).
- Landing has `<meta name="robots" content="noindex, nofollow">`, `robots.txt` with `Disallow: /`, and `X-Robots-Tag` HTTP header for a pre-launch lockdown — search engines will not index the site until these are removed.

### Fixed
- `status.html` nav links no longer point at `/stats.html` and `/status.html` (Cloudflare Pages strips `.html`).
- Dev comment (`// replace with your API URL`) removed from status page JS.
- Integration test header value used a non-ASCII char that the `fetch` Request constructor rejects; replaced with a header value that fails the middleware regex but not HTTP parsing.

### Security
- `/metrics` was leaking top-100 wallet balances and user UUIDs to unauthenticated callers. Now gated.
- CORS was wildcard, enabling cross-origin abuse from any website. Now locked to allow-list.

## [0.1.0] — 2026-04-21

Initial release. Production-ready foundation.

### Added
- **Core gateway** (Bun + Hono + Postgres + Redis)
  - Wrapper engine with cache, fallback routing, path-template substitution
  - Atomic debit with `bigint` micro-USDC, auto-refund on upstream failure
  - x402 native mode (opt-in via `ENABLE_X402_NATIVE`)
  - Policy engine (allow/deny, daily/monthly budgets, per-API caps, exclude-cache-from-budget)
  - Per-token metering with post-response reconciliation (OpenAI, Anthropic, Together)
  - Rate limiting (Redis fixed-window, per-tier)
  - Settlement service (aggregate upstream debt per period)
  - Outbound webhook subscriptions + delivery log
- **Wallet providers**
  - Placeholder (UUID-derived address, dev only)
  - Coinbase CDP Wallets (lazy-loaded, production)
- **Registry**: 27 APIs across LLM, search, scraping, voice, AI/ML, enrichment, docs, geo, social, blockchain
- **SDKs**: `@axon/client` (TypeScript), `axon-client` (Python), `axon-go` (Go)
- **Framework integrations**: LangChain (JS + Python), crewAI, Autogen, PydanticAI, Smolagents, Vercel AI SDK, Mastra, n8n
- **MCP server**: `@axon/mcp-server` for Claude Desktop, Claude Code, Cursor, Zed
- **CLI**: `@axon/cli` for ops (`axon user:create`, `axon balance`, `axon policy:set`, etc.)
- **Observability**: Prometheus `/metrics`, structured JSON logs, request-id tracing, `/health` + `/health/ready`
- **Admin surface**: `/v1/admin/users`, `/v1/admin/credit`, `/v1/admin/policy/:user_id`, `/v1/admin/settlements`
- **Webhooks inbound**: Alchemy ADDRESS_ACTIVITY (signed), manual fallback (testnet)
- **Webhooks outbound**: `deposit.received`, `call.refunded`, etc. with HMAC-SHA256 signatures
- **Email templates**: welcome, deposit-received, balance-low, rate-limit-warning
- **Deploy configs**: Dockerfile (multi-stage, non-root, tini), render.yaml, railway.toml, fly.toml, Procfile
- **CI**: GitHub Actions (typecheck, test, SDK build, registry validation, daily settlement cron, landing auto-deploy)
- **Tests**: unit (crypto, cache-key, micro-usdc, wallet-providers, path-template, policy) + integration harness
- **Docs**: quickstart, api-reference, adding-apis, architecture, deploy, security, webhooks, launch-zero-cost, first-customer-playbook
- **Landing**: index.html + stats.html ("the honesty page")
- **Admin dashboard**: single-page HTML, wallet + usage + transactions
- **Marketing kit**: Twitter thread, Show HN post, Reddit posts, waitlist emails, demo video script, Product Hunt kit
- **Blog posts**: why-we-built-axon, self-paying-research-agent-20-lines, cache-hit-rates-17-apis
- **Starter templates**: research-agent (TS + Python), n8n workflow
- **OpenAPI 3.1 spec** + Postman collection
- **Grafana dashboard** + alerting rules
- **OSS hygiene**: LICENSE (MIT), CONTRIBUTING, SECURITY, CoC, issue/PR templates, Dependabot

[Unreleased]: https://github.com/axondevi/axon/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/axondevi/axon/releases/tag/v0.1.0
