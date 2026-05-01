# API Reference

Base URL: `https://axon-kedb.onrender.com` · Self-hosted: `http://localhost:3000`

All authenticated endpoints require:

```
x-api-key: ax_live_...
```

Every response carries `x-request-id` — include it when filing support tickets so we can grep logs.

Errors are JSON:

```json
{
  "error": "insufficient_funds",
  "message": "Insufficient wallet balance",
  "meta": { "needed": "5500", "have": "1000" },
  "request_id": "a1b2c3d4…"
}
```

Rate limits: emitted as `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` on every authenticated response. 429 includes `retry-after`.

---

## Catalog

### `GET /v1/apis`

List every upstream API in the catalog.

```json
{
  "data": [
    {
      "slug": "serpapi",
      "provider": "SerpAPI",
      "category": "Web Intelligence",
      "description": "…",
      "endpoints": ["search"]
    }
  ],
  "count": 12
}
```

### `GET /v1/apis/:slug`

Details + pricing per endpoint.

```json
{
  "slug": "serpapi",
  "endpoints": [
    {
      "key": "search",
      "method": "GET",
      "path": "/search",
      "price_usd": 0.005,
      "markup_pct": 10,
      "cache_ttl": 3600,
      "effective_price_usd": 0.0055,
      "cached_price_usd": 0.0025
    }
  ]
}
```

---

## Call (the proxy)

### `ANY /v1/call/:slug/:endpoint`

Main endpoint. Request method and body are passed through to the upstream. GET params map to upstream query string; POST/PUT/PATCH bodies map to upstream body.

**Response headers:**

| Header | Meaning |
|--------|---------|
| `x-axon-cost-usdc` | What you paid for this call |
| `x-axon-cache` | `hit` or `miss` |
| `x-axon-latency-ms` | End-to-end time including upstream |
| `x-axon-refunded` | Present (`true`) if upstream failed and we refunded |

**Example:**

```bash
curl "https://axon-kedb.onrender.com/v1/call/openweather/current?lat=38.72&lon=-9.14" \
  -H "x-api-key: ax_live_..."
```

---

## Wallet

### `GET /v1/wallet/balance`

```json
{
  "address": "0x…",
  "balance_usdc": "25.000000",
  "reserved_usdc": "0.000000",
  "available_usdc": "25.000000"
}
```

### `GET /v1/wallet/transactions?limit=50`

```json
{
  "data": [
    {
      "id": "…",
      "type": "debit",
      "amount_usdc": "-0.005500",
      "api_slug": "serpapi",
      "created_at": "2026-04-21T10:00:00Z",
      "meta": { "cached": false, "endpoint": "search" }
    }
  ]
}
```

Types: `deposit`, `debit`, `refund`, `withdrawal`, `bonus`.

### `POST /v1/wallet/deposit-intent`

Get the deposit address + chain/asset info.

```json
{
  "chain": "base",
  "asset": "USDC",
  "asset_address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "deposit_address": "0x…"
}
```

---

## Usage

### `GET /v1/usage?from=&to=&api=`

```json
{
  "total_requests": 142,
  "cache_hits": 78,
  "cache_hit_rate": 0.549,
  "total_spent_usdc": "0.781500"
}
```

### `GET /v1/usage/by-api`

```json
{
  "data": [
    { "api_slug": "serpapi", "requests": 68, "cache_hits": 38, "total_spent_usdc": "0.374000" },
    { "api_slug": "firecrawl", "requests": 40, "cache_hits": 20, "total_spent_usdc": "0.242000" }
  ]
}
```

---

## Admin (internal)

Header: `x-admin-key: <ADMIN_API_KEY from .env>`

### `POST /v1/admin/users`

```json
// request
{ "email": "user@acme.dev" }

// response
{
  "user_id": "uuid",
  "api_key": "ax_live_...",
  "deposit_address": "0x…",
  "balance_usdc": "5.000000",
  "warning": "Save the API key now. It cannot be retrieved later."
}
```

### `POST /v1/admin/credit`

Credit a wallet manually (useful for testnet or manual reconciliation).

```json
{ "user_id": "uuid", "amount_usdc": "50", "onchain_tx": "0x..." }
```

### Policy CRUD

All header: `x-admin-key`.

- `GET    /v1/admin/policy/:user_id` — read current policy (or `null`)
- `PUT    /v1/admin/policy/:user_id` — upsert policy (body: `Policy` shape)
- `DELETE /v1/admin/policy/:user_id` — remove policy

`Policy` shape:

```ts
{
  allow_apis?: string[];               // allowlist (empty = all)
  deny_apis?: string[];                // blocklist (union with allow)
  daily_budget_micro?: string;         // max micro-USDC per rolling 24h
  monthly_budget_micro?: string;       // max micro-USDC per rolling 30d
  max_request_cost_micro?: string;     // hard ceiling per single call
  per_api_daily_micro?: Record<string, string>;  // per-API daily caps
  exclude_cache_from_budget?: boolean; // cache hits don't count
  label?: string;                      // human-readable tag
}
```

Violations return 403 with `error: "policy_denied"` and a `meta.rule` field identifying the rule that fired.

### Settlements

- `GET  /v1/admin/settlements?status=pending|paid|reconciled`
- `POST /v1/admin/settlements/run` — trigger aggregation for a window (body: `{start, end}` or empty = yesterday UTC)
- `POST /v1/admin/settlements/:id/paid` — mark as paid (`{paid_ref}`)

Idempotent: re-running `/run` for the same window upserts.

---

## Public stats (no auth)

- `GET /v1/stats/public?days=30` — aggregate cache-hit-rate + p50/p95 latency per API. Cached HTTP for 5 minutes.

---

## Metrics (Prometheus)

- `GET /metrics` — prometheus text format. Optional `Authorization: Bearer <METRICS_TOKEN>` if gated.

Emits:

```
axon_requests_total{api,endpoint,cache,status}           counter
axon_request_cost_usdc_total{api,endpoint,cache}         counter (micro-USDC)
axon_upstream_latency_ms_sum{api,endpoint}               counter
axon_wallet_balance_micro{user_id}                       gauge (top 100)
axon_settlements_pending_total                           gauge
```

---

## Webhooks (no auth — signature-verified)

### `POST /v1/webhooks/alchemy`

Alchemy Address Activity webhook. Verifies `x-alchemy-signature` against `ALCHEMY_WEBHOOK_SIGNING_KEY`. Credits any matching deposit address with the USDC transferred.

### `POST /v1/webhooks/manual`

Gated by `x-deposit-token: <DEPOSIT_WEBHOOK_TOKEN>`. Useful for testnet or other on-chain watchers.

```json
{ "address": "0x…", "amount_usdc": "50", "onchain_tx": "0x…" }
```

---

## HTTP status codes

| Status | Meaning |
|--------|---------|
| 200    | OK |
| 400    | `bad_request` |
| 401    | `unauthorized` — missing/invalid API key |
| 402    | `insufficient_funds` |
| 403    | `forbidden` — bad admin/webhook secret |
| 404    | `not_found` — API, endpoint, or wallet |
| 502    | `upstream_failed` — the upstream API errored (auto-refunded) |

---

## Rate limits

| Tier | Requests / min |
|------|----------------|
| Free | 10 |
| Pro  | 600 |
| Team | 3000 |
| Enterprise | Custom |

Exceeding the limit returns `429` with a `retry-after` header.
