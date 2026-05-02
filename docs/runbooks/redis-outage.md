# Redis outage

## Symptoms

- Render logs spike with `ratelimit_redis_unavailable` and
  `policy_redis_unavailable` warnings.
- Authed requests start returning 503 with `rate_limiter_unavailable`
  (production fail-closed).
- WhatsApp inbound stops dedup'ing — replays go through.
- Multi-bolha buffering (`src/whatsapp/buffer.ts`) keeps working
  in-process but cross-process dedup is gone.

## Quick check

```bash
# From your machine
redis-cli -u "$REDIS_URL" ping
# → expects PONG. Anything else → outage.

# Or via the gateway readiness probe
curl https://axon-kedb.onrender.com/health/ready
# 503 means at least one dep is down (DB or Redis)
```

## What still works

- `/health` (just liveness, no deps)
- `/v1/wallet/balance`, `/v1/agents`, every Postgres-backed read
- Public catalog `/v1/apis`, `/v1/personas`, `/v1/stats/public`

## What is broken

- Authed rate-limit (returns 503 in prod, fail-open in dev)
- Daily/monthly/per-API budget reservation (fail-open, falls back to
  Postgres `requests` aggregation — slightly less atomic)
- WhatsApp replay-guard (10-min dedup)
- Subscription concurrency lock
- Voice preview cache (every preview hits ElevenLabs uncached)

## Mitigation

1. **Check Upstash status page** for the Redis instance.
2. **If Upstash is healthy but our connection isn't:** check
   `REDIS_URL` env on Render → did someone rotate the password?
3. **If REDIS_URL is wrong:** Render → Service → Environment → Edit.
   Service redeploys; ~3 min downtime.
4. **If REDIS_URL is right but instance is gone:** spin up a new
   Upstash database, paste the new `rediss://` URL into
   `REDIS_URL`. Lost data: rate-limit counters (resets to 0 →
   visitors get a fresh window, no harm) and budget reservations
   (Postgres `requests` aggregation still bounds spend).

## Recovery verification

```bash
redis-cli -u "$REDIS_URL" ping            # PONG
curl https://axon-kedb.onrender.com/health/ready  # {"status":"ready"}
# Trigger an authed request and confirm rate-limit headers come back:
curl -H "X-API-Key: $AXON_KEY" -i https://axon-kedb.onrender.com/v1/wallet/balance \
  | grep -i x-ratelimit
```

## Postmortem checklist

- [ ] Note start/end time in `admin_audit_log` summary
- [ ] Estimate request volume affected (Render logs)
- [ ] Confirm no balance corruption (compare wallets.balance with
      sum of transactions)
