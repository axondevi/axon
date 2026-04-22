import { Hono } from 'hono';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '~/db';
import { requests } from '~/db/schema';
import { fromMicro } from '~/wallet/service';

const app = new Hono();

// ─── GET /v1/usage?from=&to=&api= ─────────────────────
app.get('/', async (c) => {
  const user = c.get('user') as { id: string };
  const fromQ = c.req.query('from');
  const toQ = c.req.query('to');
  const apiQ = c.req.query('api');

  const conds = [eq(requests.userId, user.id)];
  if (fromQ) conds.push(gte(requests.createdAt, new Date(fromQ)));
  if (toQ) conds.push(lte(requests.createdAt, new Date(toQ)));
  if (apiQ) conds.push(eq(requests.apiSlug, apiQ));

  const [agg] = await db
    .select({
      total_requests: sql<number>`count(*)::int`,
      total_cost: sql<string>`coalesce(sum(${requests.costMicro})::text, '0')`,
      cache_hits: sql<number>`count(*) filter (where ${requests.cacheHit})::int`,
    })
    .from(requests)
    .where(and(...conds));

  return c.json({
    total_requests: agg.total_requests,
    cache_hits: agg.cache_hits,
    cache_hit_rate:
      agg.total_requests > 0
        ? +(agg.cache_hits / agg.total_requests).toFixed(4)
        : 0,
    total_spent_usdc: fromMicro(BigInt(agg.total_cost)),
  });
});

// ─── GET /v1/usage/by-api ─────────────────────────────
app.get('/by-api', async (c) => {
  const user = c.get('user') as { id: string };
  const rows = await db
    .select({
      api_slug: requests.apiSlug,
      count: sql<number>`count(*)::int`,
      total_cost: sql<string>`sum(${requests.costMicro})::text`,
      cache_hits: sql<number>`count(*) filter (where ${requests.cacheHit})::int`,
    })
    .from(requests)
    .where(eq(requests.userId, user.id))
    .groupBy(requests.apiSlug)
    .orderBy(desc(sql`sum(${requests.costMicro})`));

  return c.json({
    data: rows.map((r) => ({
      api_slug: r.api_slug,
      requests: r.count,
      cache_hits: r.cache_hits,
      total_spent_usdc: fromMicro(BigInt(r.total_cost ?? '0')),
    })),
  });
});

export default app;
