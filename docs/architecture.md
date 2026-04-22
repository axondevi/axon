# Architecture

Axon is small and deliberately so. This page is the whole thing.

## System diagram

```
Agent / SDK
    │  HTTPS + x-api-key
    ▼
┌───────────────────────────────────────────────┐
│  Hono gateway (Bun)                           │
│  ─ auth middleware (API key → user)           │
│  ─ per-tier rate limit                        │
└────┬─────────────────┬────────────────────────┘
     ▼                 ▼
 Wallet svc        Wrapper engine
 (Postgres)       ┌─────────────────────┐
     ▲            │ Cache key (sha256)  │
     │            │ Redis lookup        │
     │            └──┬───────────────┬──┘
     │           hit │           miss│
     │               ▼               ▼
     │        charge 50%    debit full → upstream HTTP
     │               │               │
     │               │          ok  │  err
     │               │               │   │
     │               │               │   └── auto-refund
     │               │               ▼
     │               │         cache.setex(ttl)
     │               ▼               │
     │        log request ◄──────────┘
     │         (Postgres)
     ▼
 Response body + x-axon-* headers
```

## Data model

5 tables. That's it.

```
users
  ├─ id (uuid PK)
  ├─ email
  ├─ api_key_hash (sha256)
  └─ tier

wallets
  ├─ user_id (PK, FK → users)
  ├─ address (unique, on-chain deposit addr)
  ├─ balance_micro (bigint, USDC*1e6)
  └─ reserved_micro

transactions (immutable ledger)
  ├─ id
  ├─ user_id
  ├─ type  (deposit | debit | refund | withdrawal | bonus)
  ├─ amount_micro  (signed)
  ├─ api_slug, request_id, onchain_tx
  └─ meta (jsonb)

api_registry (optional DB override; JSON files work alone)
  ├─ slug (PK)
  ├─ provider, category, base_url
  └─ config (jsonb — full endpoints shape)

requests (usage log, immutable)
  ├─ id, user_id, api_slug, endpoint
  ├─ cost_micro, markup_micro
  ├─ cache_hit, latency_ms, status
  └─ created_at
```

## Key invariants

1. **No floats touch money.** Everything is `bigint` micro-USDC (`1e6 = 1 USDC`). Arithmetic is exact.

2. **Debits are atomic.** The wallet service does:
   ```sql
   UPDATE wallets
   SET balance_micro = balance_micro - $amt
   WHERE user_id = $u AND (balance_micro - reserved_micro) >= $amt
   ```
   Zero rows updated = insufficient funds, we throw. No race conditions, no distributed lock.

3. **Refund on upstream failure.** Any non-2xx from upstream triggers a compensating credit. Users are never debited for calls they didn't get a result for.

4. **Cache is content-addressed.** Key = `sha256(sorted params + body)`. Identical inputs → identical key → identical response. The 50% discount on cache hits is how we take margin without subsidizing.

5. **Registry is config.** Adding an API = adding a JSON. No deploy, no code review. Supply-side scales horizontally.

## Request lifecycle

For a cache-miss `GET /v1/call/serpapi/search?q=espresso`:

1. Gateway receives request, logs method + path
2. Auth middleware: hashes `x-api-key`, looks up user. If not found → 401.
3. Rate limit check against user's tier.
4. Route matches `/:slug/:endpoint` → wrapper engine
5. Engine loads `registry/serpapi.json`, finds `search` endpoint
6. Cache key computed from query params (sorted). Redis GET.
7. Redis miss. Debit wallet: `price_usd * (1 + markup_pct/100)` in micro. Atomic SQL.
8. Build upstream URL: `base_url + endpoint.path`, apply auth (query param `api_key`), add user's query params.
9. HTTP call to SerpAPI.
10. Response 200 → cache it (`SETEX` with `endpoint.cache_ttl`), log request row, return to client with `x-axon-*` headers.
11. Response ≥400 → skip cache, issue refund transaction, return upstream body with `x-axon-refunded: true`.

## Money flow

```
Client USDC on Base   ──deposit──►   Custodial wallet (Coinbase CDP)
                                             │
                                             ▼
                                     Internal ledger
                                     (balance_micro)
                                             │
                                 per-request │ debit
                                             ▼
                                    Our treasury (margin retained)
                                             │
                              daily/weekly  │ settlement
                                             ▼
                                  Upstream provider accounts
                                    (funded from prior debits)
```

**We never front money for upstream.** The debit happens *before* the upstream call. Settlement with upstream providers is paid from already-debited user funds. Zero working capital required for operation.

## What we chose not to do (and why)

- **No distributed cache invalidation.** Cache TTL is the sole expiry. If upstream data is stale for 1 hour, that's the contract.
- **No speculative prefetching.** Cache fills on demand. Simpler, and aligns cost with behavior.
- **No smart routing across providers yet.** Each API is its own slug. Fallback routing is roadmap — it adds complexity (which provider becomes canonical? how do we reconcile pricing?) that's premature pre-launch.
- **No self-custody wallets in MVP.** Agents + self-custody = lost keys + lost funds. Custodial via CDP; we ship non-custodial x402 later for advanced users.
- **No per-token LLM metering in MVP.** Flat price per call. The ecosystem will complain; we'll fix in ~2 weeks. Easier to ship flat pricing and iterate than block on token accounting.

## Scaling notes

The current design comfortably handles ~1000 req/s on a single Bun instance with Postgres + Redis. Bottlenecks, in order:

1. **Postgres INSERTs on `requests` and `transactions`** — around 500 req/s per Postgres node. Mitigation: batch inserts via a buffer, or move the request log to Tinybird/ClickHouse.
2. **Redis GET on cache check** — ~50k ops/s on Upstash. Not a bottleneck until much later.
3. **Upstream latency** — usually dominates total response time. Mitigation: more cache, fallback routing, geo-distributed edge.

Horizontal scaling: wallet debits are already atomic at the DB level, so Axon itself is stateless. Run N instances behind a load balancer, same database, same Redis. Done.
