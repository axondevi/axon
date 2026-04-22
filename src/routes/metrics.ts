/**
 * Prometheus-compatible metrics endpoint.
 *
 *   GET /metrics
 *
 * No auth (following Prometheus convention). Put it behind an internal
 * loadbalancer / firewall in prod. Optional METRICS_TOKEN gates it in
 * shared environments.
 *
 * Emits:
 *   axon_requests_total{api, endpoint, cache, status}
 *   axon_request_cost_usdc_total{api, endpoint, cache}
 *   axon_wallet_balance_usdc{user_id}  (top 100 by balance)
 *   axon_upstream_latency_ms_sum / _count{api, endpoint}   (histogram-ish)
 *   axon_settlements_pending_total
 */
import { Hono } from 'hono';
import { and, desc, gte, sql } from 'drizzle-orm';
import { db } from '~/db';
import { requests, wallets, settlements } from '~/db/schema';

const app = new Hono();

const TOKEN = process.env.METRICS_TOKEN;

app.get('/', async (c) => {
  if (TOKEN && c.req.header('authorization') !== `Bearer ${TOKEN}`) {
    return c.text('unauthorized', 401);
  }

  // Window: last 15 minutes (scrape-friendly)
  const since = new Date(Date.now() - 15 * 60 * 1000);

  const reqAgg = await db
    .select({
      api: requests.apiSlug,
      endpoint: requests.endpoint,
      cache: requests.cacheHit,
      status: requests.status,
      count: sql<number>`count(*)::int`,
      cost_sum: sql<string>`coalesce(sum(${requests.costMicro})::text, '0')`,
      latency_sum: sql<string>`coalesce(sum(${requests.latencyMs})::text, '0')`,
    })
    .from(requests)
    .where(gte(requests.createdAt, since))
    .groupBy(
      requests.apiSlug,
      requests.endpoint,
      requests.cacheHit,
      requests.status,
    );

  const topWallets = await db
    .select({
      userId: wallets.userId,
      balance: wallets.balanceMicro,
    })
    .from(wallets)
    .orderBy(desc(wallets.balanceMicro))
    .limit(100);

  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(settlements)
    .where(and(sql`${settlements.status} = 'pending'`));

  const lines: string[] = [];

  lines.push('# HELP axon_requests_total Requests processed by the gateway');
  lines.push('# TYPE axon_requests_total counter');
  for (const r of reqAgg) {
    lines.push(
      `axon_requests_total{api="${escape(r.api)}",endpoint="${escape(r.endpoint)}",cache="${r.cache ? 'hit' : 'miss'}",status="${r.status ?? 0}"} ${r.count}`,
    );
  }

  lines.push('');
  lines.push('# HELP axon_request_cost_usdc_total USDC cost charged per group (micro-USDC)');
  lines.push('# TYPE axon_request_cost_usdc_total counter');
  for (const r of reqAgg) {
    lines.push(
      `axon_request_cost_usdc_total{api="${escape(r.api)}",endpoint="${escape(r.endpoint)}",cache="${r.cache ? 'hit' : 'miss'}"} ${r.cost_sum}`,
    );
  }

  lines.push('');
  lines.push('# HELP axon_upstream_latency_ms_sum Sum of upstream latencies (ms) in window');
  lines.push('# TYPE axon_upstream_latency_ms_sum counter');
  for (const r of reqAgg) {
    lines.push(
      `axon_upstream_latency_ms_sum{api="${escape(r.api)}",endpoint="${escape(r.endpoint)}"} ${r.latency_sum}`,
    );
  }

  lines.push('');
  lines.push('# HELP axon_wallet_balance_micro Top 100 wallet balances (micro-USDC)');
  lines.push('# TYPE axon_wallet_balance_micro gauge');
  for (const w of topWallets) {
    lines.push(
      `axon_wallet_balance_micro{user_id="${escape(w.userId)}"} ${w.balance.toString()}`,
    );
  }

  lines.push('');
  lines.push('# HELP axon_settlements_pending_total Pending settlement rows');
  lines.push('# TYPE axon_settlements_pending_total gauge');
  lines.push(`axon_settlements_pending_total ${pending?.count ?? 0}`);

  return c.text(lines.join('\n') + '\n', 200, {
    'content-type': 'text/plain; version=0.0.4',
  });
});

function escape(s: string | null | undefined): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export default app;
