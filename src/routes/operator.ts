/**
 * Operator dashboard — aggregated metrics across ALL users.
 * Admin-authed. This is what the business operator sees, not a customer.
 *
 * `markupMicro` is gold: the engine records it as the operator's profit
 * per request (for cache hits it equals the full charge, since no
 * upstream cost was incurred). So:
 *
 *   gross_revenue = SUM(costMicro)
 *   net_profit    = SUM(markupMicro)
 *   upstream_cost = gross_revenue - net_profit
 */
import { Hono } from 'hono';
import { and, gte, eq, sql, desc } from 'drizzle-orm';
import { db } from '~/db';
import { requests, users, wallets, settlements } from '~/db/schema';
import { adminAuth } from '~/auth/middleware';
import { fromMicro } from '~/wallet/service';
import { env } from '~/config';

const app = new Hono();

// ─── GET /v1/admin/operator-stats ─────────────────────
app.get('/stats', adminAuth, async (c) => {
  const windowDays = Math.min(Number(c.req.query('days') ?? 30), 365);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Global aggregates — one row, all numbers
  const [totals] = await db
    .select({
      total_requests: sql<number>`count(*)::int`,
      cache_hits: sql<number>`count(*) filter (where ${requests.cacheHit})::int`,
      gross_revenue_micro: sql<bigint>`coalesce(sum(${requests.costMicro}), 0)::bigint`,
      net_profit_micro: sql<bigint>`coalesce(sum(${requests.markupMicro}), 0)::bigint`,
      cache_profit_micro: sql<bigint>`coalesce(sum(${requests.markupMicro}) filter (where ${requests.cacheHit}), 0)::bigint`,
      live_profit_micro: sql<bigint>`coalesce(sum(${requests.markupMicro}) filter (where not ${requests.cacheHit}), 0)::bigint`,
      distinct_users: sql<number>`count(distinct ${requests.userId})::int`,
    })
    .from(requests)
    .where(
      and(
        gte(requests.createdAt, since),
        eq(sql`coalesce(${requests.status}, 200)`, 200),
      ),
    );

  // Per-API breakdown
  const perApi = await db
    .select({
      api_slug: requests.apiSlug,
      requests: sql<number>`count(*)::int`,
      cache_hits: sql<number>`count(*) filter (where ${requests.cacheHit})::int`,
      gross_revenue_micro: sql<bigint>`coalesce(sum(${requests.costMicro}), 0)::bigint`,
      net_profit_micro: sql<bigint>`coalesce(sum(${requests.markupMicro}), 0)::bigint`,
    })
    .from(requests)
    .where(
      and(
        gte(requests.createdAt, since),
        eq(sql`coalesce(${requests.status}, 200)`, 200),
      ),
    )
    .groupBy(requests.apiSlug)
    .orderBy(sql`sum(${requests.markupMicro}) desc`);

  // User counts
  const [userCounts] = await db
    .select({
      total_users: sql<number>`count(*)::int`,
    })
    .from(users);

  // Pending settlements
  const pending = await db
    .select({
      api_slug: settlements.apiSlug,
      owed_micro: sql<bigint>`sum(${settlements.owedMicro})::bigint`,
    })
    .from(settlements)
    .where(eq(settlements.status, 'pending'))
    .groupBy(settlements.apiSlug);

  const pendingSettlementMicro = pending.reduce(
    (acc, p) => acc + BigInt(p.owed_micro),
    0n,
  );

  const grossRev = BigInt(totals.gross_revenue_micro);
  const netProfit = BigInt(totals.net_profit_micro);
  const upstreamCost = grossRev - netProfit;
  const cacheHitRate =
    totals.total_requests > 0 ? totals.cache_hits / totals.total_requests : 0;
  const profitMargin =
    grossRev > 0n ? Number((netProfit * 10000n) / grossRev) / 100 : 0;

  return c.json({
    window_days: windowDays,
    generated_at: new Date().toISOString(),

    totals: {
      requests: totals.total_requests,
      cache_hits: totals.cache_hits,
      cache_hit_rate: Number(cacheHitRate.toFixed(4)),
      active_users_in_window: totals.distinct_users,
      total_users_ever: userCounts.total_users,

      gross_revenue_usdc: fromMicro(grossRev),
      upstream_cost_usdc: fromMicro(upstreamCost),
      net_profit_usdc: fromMicro(netProfit),
      profit_margin_pct: profitMargin,

      cache_profit_usdc: fromMicro(BigInt(totals.cache_profit_micro)),
      live_profit_usdc: fromMicro(BigInt(totals.live_profit_micro)),

      pending_settlement_usdc: fromMicro(pendingSettlementMicro),
    },

    by_api: perApi.map((a) => {
      const gross = BigInt(a.gross_revenue_micro);
      const profit = BigInt(a.net_profit_micro);
      const upstream = gross - profit;
      const margin = gross > 0n ? Number((profit * 10000n) / gross) / 100 : 0;
      return {
        api_slug: a.api_slug,
        requests: a.requests,
        cache_hits: a.cache_hits,
        cache_hit_rate:
          a.requests > 0 ? Number((a.cache_hits / a.requests).toFixed(4)) : 0,
        gross_revenue_usdc: fromMicro(gross),
        upstream_cost_usdc: fromMicro(upstream),
        net_profit_usdc: fromMicro(profit),
        profit_margin_pct: margin,
      };
    }),

    pending_settlements_by_api: pending.map((p) => ({
      api_slug: p.api_slug,
      owed_usdc: fromMicro(BigInt(p.owed_micro)),
    })),
  });
});

// ─── GET /v1/admin/operator/wallets ───────────────────
// Treasury + list of user wallets with Basescan-ready addresses
app.get('/wallets', adminAuth, async (c) => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const treasury = env.TREASURY_ADDRESS;
  const treasuryConfigured = !!treasury && treasury.toLowerCase() !== ZERO;

  // Join users + wallets to list with balance and creation date
  const rows = await db
    .select({
      user_id: users.id,
      email: users.email,
      tier: users.tier,
      address: wallets.address,
      balance_micro: wallets.balanceMicro,
      reserved_micro: wallets.reservedMicro,
      created_at: users.createdAt,
    })
    .from(users)
    .leftJoin(wallets, eq(wallets.userId, users.id))
    .orderBy(desc(users.createdAt))
    .limit(100);

  return c.json({
    treasury: {
      address: treasury || ZERO,
      configured: treasuryConfigured,
      basescan_url: treasuryConfigured
        ? `https://basescan.org/address/${treasury}`
        : null,
      note: treasuryConfigured
        ? 'Funds sweep here when sweep function is implemented.'
        : 'Treasury not configured. Set TREASURY_ADDRESS in Render env to a wallet you control. Without this, profit cannot be swept out.',
    },
    turnkey: {
      organization_id: process.env.TURNKEY_ORGANIZATION_ID ?? null,
      provider: env.WALLET_PROVIDER,
      dashboard_url: 'https://app.turnkey.com',
    },
    user_wallets: rows.map((r) => ({
      user_id: r.user_id,
      email: r.email,
      tier: r.tier,
      address: r.address,
      balance_usdc: r.balance_micro ? fromMicro(BigInt(r.balance_micro)) : '0.000000',
      reserved_usdc: r.reserved_micro ? fromMicro(BigInt(r.reserved_micro)) : '0.000000',
      basescan_url: r.address ? `https://basescan.org/address/${r.address}` : null,
      created_at: r.created_at,
    })),
  });
});

// ─── POST /v1/admin/operator/reset-signup-limit ───────
// Clear signup rate-limit for a specific IP (or all if no ip given).
// Useful when operator is testing signup flow from their own IP.
app.post('/reset-signup-limit', adminAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ip?: string };
  const { redis } = await import('~/cache/redis');

  // SCAN-based deletion. The previous code used KEYS which is O(N) over
  // the entire keyspace and blocks Redis for the duration — at any
  // production scale that's a stop-the-world event. SCAN walks the
  // keyspace incrementally with bounded server work per batch.
  const pattern = body.ip
    ? `signup:ratelimit:${body.ip}:*`
    : 'signup:ratelimit:*';

  let cleared = 0;
  let cursor = '0';
  do {
    const [next, batch] = (await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500)) as [string, string[]];
    cursor = next;
    if (batch.length) {
      await redis.del(...batch);
      cleared += batch.length;
    }
  } while (cursor !== '0');

  return c.json({ cleared, scope: body.ip ? 'ip' : 'all', ip: body.ip ?? null });
});

export default app;
