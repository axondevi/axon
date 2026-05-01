/**
 * Prometheus-compatible metrics endpoint.
 *
 *   GET /metrics  (Authorization: Bearer $METRICS_TOKEN)
 *
 * Emits wallet balances keyed by user_id — MUST be gated. In production the
 * config layer enforces METRICS_TOKEN is set; here we reject any request
 * lacking the bearer even in dev if the token is configured.
 */
import { Hono } from 'hono';
import { and, desc, gte, sql } from 'drizzle-orm';
import { timingSafeEqual, createHash } from 'node:crypto';
import { db } from '~/db';
import { requests, wallets, settlements } from '~/db/schema';
import { env } from '~/config';

// Stable, non-reversible label for a userId. Without this, Prometheus
// labels would carry raw user UUIDs straight to whoever scrapes the
// metrics endpoint — even with the bearer token gate, that's needless
// PII propagation. Hash + first 12 chars is enough for cardinality
// (collision probability negligible at the wallet count scale).
function hashUserId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

const app = new Hono();

function authorized(header: string | undefined): boolean {
  const token = env.METRICS_TOKEN;
  if (!token) return false;
  if (!header) return false;
  const expected = `Bearer ${token}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

app.get('/', async (c) => {
  if (!authorized(c.req.header('authorization'))) {
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
      `axon_wallet_balance_micro{user_hash="${hashUserId(w.userId)}"} ${w.balance.toString()}`,
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

// Prometheus label-value escaping per the exposition format:
// only \, ", and newline are special — but a value containing `}` or `=`
// is fine inside double-quotes. Escape backslash first so we don't
// double-escape the slashes we just inserted.
function escape(s: string | null | undefined): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export default app;
