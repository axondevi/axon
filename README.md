# Axon

> **Universal API gateway for autonomous agents.**
> One endpoint. One USDC wallet. Every paid API your agent needs.

Axon is the aggregation layer on top of x402 (HTTP 402 Payment Required). Your agent deposits USDC on Base once, then calls any listed API through a single endpoint. Per-request pricing, automatic cache, refunds on failure, no per-vendor signups.

---

## What's in this repo

```
axon/
├── src/                          # Bun + Hono server
│   ├── index.ts                  # app entry, graceful shutdown
│   ├── scheduler.ts              # cron worker (daily settlement)
│   ├── config.ts                 # env parsing (Zod)
│   ├── types.ts                  # Hono context typing
│   ├── db/                       # schema, client, migrate, seed, bootstrap
│   ├── cache/                    # Redis client
│   ├── auth/                     # API key + admin middleware
│   ├── middleware/               # rate-limit, request-id
│   ├── wallet/                   # balance, debit, providers (placeholder/CDP)
│   ├── registry/                 # API catalog loader (hot-reload)
│   ├── wrapper/                  # proxy engine (cache, fallback, x402 aware)
│   ├── payment/                  # x402 native middleware
│   ├── policy/                   # budgets, allow/deny, per-API caps
│   ├── metering/                 # per-token calculators (openai/anthropic/together)
│   ├── settlement/               # upstream debt aggregation
│   ├── routes/                   # wallet, apis, call, usage, webhooks, policy, settlement, stats, metrics
│   ├── lib/                      # crypto, errors, logger
│   └── tests/                    # unit + integration
├── registry/                     # JSON configs — 27 APIs
│   ├── LLMs: openai · anthropic · together · perplexity
│   ├── Search: serpapi · exa · tavily · brave-search · bright-data
│   ├── Scraping: firecrawl
│   ├── Voice: elevenlabs · deepgram · cartesia
│   ├── AI/ML: replicate · stability · runway · voyage · jina
│   ├── Enrichment: apollo · hunter · clearbit
│   ├── Docs: mindee · deepl
│   ├── Geo: openweather · ipinfo
│   └── Data: neynar · alchemy
├── drizzle/                      # Versioned SQL migrations
├── sdk/
│   ├── js/                       # @axon/client
│   ├── python/                   # axon-client
│   └── go/                       # axon-go
├── integrations/                 # 9 framework packages
│   ├── langchain-js · langchain-python
│   ├── crewai · autogen · pydantic-ai · smolagents
│   ├── vercel-ai · mastra · n8n
├── mcp-server/                   # @axon/mcp-server — Claude Desktop/Code/Cursor/Zed
├── examples/                     # minimal runnable snippets (TS/Python/Go/curl/MCP)
├── templates/                    # clone-and-run: research-agent-ts/python, n8n-workflow
├── docs/                         # quickstart, api-reference, adding-apis, architecture, deploy, security
├── blog/                         # why-we-built / tutorial / cache-hit-rates
├── landing/                      # marketing site (index + stats.html)
├── admin/                        # self-serve dashboard
├── marketing/                    # Twitter/HN/Reddit kits + demo script + PH kit
├── scripts/                      # smoke-test.sh
├── Dockerfile · docker-compose.yml
├── railway.toml · fly.toml · Procfile · .dockerignore
├── bunfig.toml · drizzle.config.ts
├── package.json · tsconfig.json
└── .env.example
```

---

## Quick start (local dev)

### 1. Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Docker (for local Postgres + Redis)
- A free tier account on each upstream API you want to enable

### 2. Install

```bash
bun install
cp .env.example .env
```

Fill in `.env`:

- Generate `MASTER_ENCRYPTION_KEY`: `openssl rand -hex 32`
- Generate `ADMIN_API_KEY`: `openssl rand -hex 32`
- Add your upstream API keys (`UPSTREAM_KEY_OPENAI`, etc.)

### 3. Start infrastructure

```bash
docker compose up -d
```

### 4. Initialize database

```bash
bun run db:push
```

### 5. Run

```bash
bun run dev
```

Axon is now on `http://localhost:3000`.

### 6. Create your first user

```bash
curl -X POST http://localhost:3000/v1/admin/users \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"email": "me@you.dev"}'
```

Response:

```json
{
  "user_id": "…",
  "api_key": "ax_live_abc123…",
  "deposit_address": "0x…",
  "balance_usdc": "5.000000"
}
```

### 7. Make a paid call

```bash
curl "http://localhost:3000/v1/call/serpapi/search?q=best+espresso+in+lisbon" \
  -H "x-api-key: ax_live_abc123…"
```

Check the response headers:
- `x-axon-cost-usdc: 0.005500`
- `x-axon-cache: miss`  (try the same query again — it'll be `hit`)

---

## API surface (cheatsheet)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness |
| `GET`  | `/v1/apis` | List catalog |
| `GET`  | `/v1/apis/:slug` | Details + pricing |
| `ANY`  | `/v1/call/:slug/:endpoint` | **Main proxy** |
| `GET`  | `/v1/wallet/balance` | Balance |
| `GET`  | `/v1/wallet/transactions` | Ledger |
| `POST` | `/v1/wallet/deposit-intent` | Get deposit address |
| `GET`  | `/v1/usage` | Aggregate usage |
| `GET`  | `/v1/usage/by-api` | Usage per API |
| `POST` | `/v1/admin/users` | Create user (admin) |
| `POST` | `/v1/admin/credit` | Credit wallet (admin / webhook) |

---

## Adding a new API to the catalog

1. Create `registry/{slug}.json` following the shape of existing configs.
2. Add `UPSTREAM_KEY_{SLUG_UPPERCASE}=…` to `.env`.
3. Restart. That's it.

```json
{
  "slug": "my-api",
  "provider": "MyProvider",
  "category": "Data",
  "description": "…",
  "base_url": "https://api.myprovider.com",
  "auth": { "type": "bearer" },
  "endpoints": {
    "doThing": {
      "method": "POST",
      "path": "/v1/do-thing",
      "price_usd": 0.01,
      "markup_pct": 10,
      "cache_ttl": 3600,
      "cache_on_body": true
    }
  }
}
```

Auth types supported: `bearer`, `header`, `query`, `none`.

---

## Architecture cheatsheet

```
Client / Agent ──→ Hono gateway ──→ Auth (API key)
                                    ↓
                              Wallet (atomic debit via SQL)
                                    ↓
                         Cache check (Redis, content-hashed key)
                           │            │
                       hit │            │ miss
                           ↓            ↓
                   Charge 50%    Call upstream + markup
                           │            │
                           └────→ Log request (Postgres)
                                    ↓
                             Return body + headers
```

### Key design decisions

- **Bigint micro-USDC** everywhere. No floats. `1 USDC = 1_000_000 micro-USDC`.
- **Single-statement atomic debit.** `UPDATE wallets SET balance = balance - X WHERE available >= X`. No distributed locks, no race conditions.
- **Refund on upstream failure.** Non-2xx responses trigger an automatic `refund` transaction. Users are never debited for failed calls.
- **Cache is content-addressed.** Same params → same cache key → same response. 50% discount on cache hits is the hidden margin of the business.
- **Registry in JSON, not code.** Adding an API is a config change, not a deploy.

---

## Roadmap (next 90 days)

- [ ] LangChain + crewAI integration packages
- [ ] x402 native mode (pay per call, no pre-deposit)
- [ ] Coinbase CDP wallet integration (per-user deposit addresses)
- [ ] On-chain deposit watcher (webhook from Alchemy/CDP)
- [ ] Settlement service (pay upstream providers in batch)
- [ ] Policy engine (budgets, allowlists, kill-switches)
- [ ] Per-token metering for LLM endpoints
- [ ] Provider fallback routing
- [ ] Public dashboard: cache-hit rate + latency per API
- [ ] Stripe Issuing integration (virtual cards for agents)

---

## Go-to-market kit

See `marketing/`:

- `twitter-launch-thread.md` — launch thread with 10 tweets + asset checklist
- `hn-show-post.md` — Show HN title, body, and ready-to-go objection replies
- `reddit-posts.md` — one variant per sub (LocalLLaMA, LangChain, AI_Agents, Entrepreneur)
- `waitlist-emails.md` — 5 emails (confirmation → activation → nudge → first-call → monthly)

---

## License

TBD. Dual-license or source-available pending decision.
