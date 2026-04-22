/**
 * Public, anonymized stats. No auth required.
 *
 * Used by landing/stats.html as a marketing asset. Shows aggregate
 * cache-hit-rate and median latency per API — builds trust and pulls SEO.
 *
 * No per-user data. No request bodies. No IP. Pure aggregates.
 */
import { Hono } from 'hono';
import { and, gte, sql } from 'drizzle-orm';
import { db } from '~/db';
import { requests } from '~/db/schema';

const app = new Hono();

// ─── GET /v1/stats/public ─────────────────────────────
app.get('/public', async (c) => {
  const windowDays = Math.min(Number(c.req.query('days') ?? 30), 90);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      api_slug: requests.apiSlug,
      requests: sql<number>`count(*)::int`,
      cache_hits: sql<number>`count(*) filter (where ${requests.cacheHit})::int`,
      p50_latency_ms: sql<number>`
        coalesce(
          (percentile_cont(0.5) within group (order by ${requests.latencyMs}))::int,
          0
        )`,
      p95_latency_ms: sql<number>`
        coalesce(
          (percentile_cont(0.95) within group (order by ${requests.latencyMs}))::int,
          0
        )`,
    })
    .from(requests)
    .where(and(gte(requests.createdAt, since)))
    .groupBy(requests.apiSlug)
    .orderBy(sql`count(*) desc`);

  const payload = rows.map((r) => ({
    api: r.api_slug,
    requests: r.requests,
    cache_hit_rate:
      r.requests > 0 ? +(r.cache_hits / r.requests).toFixed(4) : 0,
    p50_latency_ms: r.p50_latency_ms,
    p95_latency_ms: r.p95_latency_ms,
  }));

  const totalRequests = rows.reduce((acc, r) => acc + r.requests, 0);
  const totalCacheHits = rows.reduce((acc, r) => acc + r.cache_hits, 0);

  // 5-minute cache on this endpoint via HTTP headers.
  c.header('cache-control', 'public, max-age=300, s-maxage=300');

  return c.json({
    window_days: windowDays,
    generated_at: new Date().toISOString(),
    totals: {
      requests: totalRequests,
      cache_hit_rate:
        totalRequests > 0 ? +(totalCacheHits / totalRequests).toFixed(4) : 0,
    },
    by_api: payload,
  });
});

export default app;
