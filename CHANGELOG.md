# Changelog

All notable changes to Axon are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org).

Unreleased changes appear at the top. When we cut a release, they move under a dated version header.

## [Unreleased]

### Added
- …

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

[Unreleased]: https://github.com/axondev/axon/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/axondev/axon/releases/tag/v0.1.0
