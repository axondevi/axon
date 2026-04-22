# Adding a New Upstream API

Axon's catalog is **config-driven**: to add a new API you usually don't touch code — you drop a JSON into `registry/` and set one env var.

## 1. Create the config

Save `registry/{slug}.json`:

```json
{
  "slug": "myapi",
  "provider": "MyCo",
  "category": "Data",
  "description": "One-line description agents will see in the catalog.",
  "homepage": "https://myapi.com/docs",
  "base_url": "https://api.myapi.com",
  "auth": { "type": "bearer" },
  "endpoints": {
    "lookup": {
      "method": "GET",
      "path": "/v1/lookup",
      "price_usd": 0.01,
      "markup_pct": 10,
      "cache_ttl": 3600
    },
    "enrich": {
      "method": "POST",
      "path": "/v1/enrich",
      "price_usd": 0.05,
      "markup_pct": 10,
      "cache_ttl": 86400,
      "cache_on_body": true
    }
  }
}
```

### Field reference

| Field | Purpose |
|-------|---------|
| `slug` | URL-safe identifier, used in `/v1/call/{slug}/…` |
| `provider` | Display name (for catalog) |
| `category` | Broad grouping: LLM, Web Intelligence, Voice, Enrichment, Geo, etc. |
| `base_url` | Upstream base URL |
| `auth.type` | `bearer`, `header`, `query`, or `none` |
| `auth.name` | Header or query param name (for `header`/`query` types) |
| `auth.prefix` | Optional prefix like `"Token "` or `"DeepL-Auth-Key "` |
| `endpoints.{key}.method` | HTTP method |
| `endpoints.{key}.path` | Upstream path (relative to `base_url`) |
| `endpoints.{key}.price_usd` | Base price per successful call |
| `endpoints.{key}.markup_pct` | Your margin on top (e.g. 10) |
| `endpoints.{key}.cache_ttl` | Cache TTL in seconds (0 = no cache) |
| `endpoints.{key}.cache_on_body` | Include POST body in cache key (default: query only) |

## 2. Add the upstream key

In `.env`:

```
UPSTREAM_KEY_MYAPI=sk_...
```

The env var name is always `UPSTREAM_KEY_{SLUG_UPPERCASE}` with `-` → `_`.

## 3. Restart

```bash
bun run dev
```

Registry reloads from disk on cold start. (Hot-reload on registry change is roadmap.)

## 4. Test

```bash
curl "http://localhost:3000/v1/call/myapi/lookup?name=acme" \
  -H "x-api-key: ax_live_..."
```

Check response headers for `x-axon-cost-usdc` and `x-axon-cache: miss`. Hit the same URL again — you should see `x-axon-cache: hit` and 50% cost.

---

## How to price a new API

A sensible default:

1. Look up upstream price per call → `price_usd`
2. Set `markup_pct`:
   - 10% default
   - 15-20% if margin-sensitive category (enrichment)
   - 25% if cache hits dominate volume (you'll lose nothing on misses)
3. Set `cache_ttl`:
   - 0 if output varies (LLMs with temperature, random sampling)
   - 3600 for "mostly deterministic" (search, scraping)
   - 86400+ for "deterministic given inputs" (embeddings, TTS)
   - 2592000 (30d) for "never changes" (geocoding, static enrichment)

## When you DO need to touch code

- **Path templates** with `:id` style params → handled via upstream URL substitution (roadmap).
- **Auth that isn't header/query/bearer/none** (HMAC, OAuth client-credentials) → add a new `auth.type` to `src/wrapper/engine.ts → applyAuth`.
- **Per-token or per-byte metering** (LLMs, speech) → add a metering plugin that reads the upstream response and re-computes cost after the call. Roadmap.
- **Async APIs with job polling** (Replicate predictions, long-running Firecrawl crawls) → model the poll endpoint with `price_usd: 0`.

## Private / self-registered APIs

On Team and Enterprise plans you can register your own upstream:

```
POST /v1/admin/registry
x-admin-key: ...

{ ...same shape as the JSON file }
```

The config lands in the `api_registry` table and is loaded alongside the JSON files. Useful when a customer wants their internal API to be available to an agent through the same gateway.
