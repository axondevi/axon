/**
 * Settlement service.
 *
 * Periodically aggregates how much Axon owes each upstream provider for
 * successful (non-cached) requests in a given window, then inserts one
 * settlement row per (api_slug, period) that the finance/ops team marks
 * `paid` after wiring/USD/ACH to the provider.
 *
 * The cost attributed to settlement is `cost_micro` (pre-markup, i.e., our
 * upstream cost). `markup_micro` stays in Axon's treasury.
 *
 * The job is idempotent — re-running for the same period upserts the row.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '~/db';
import { requests, settlements } from '~/db/schema';

export interface SettlementPeriod {
  start: Date;
  end: Date;
}

/** Settle one API slug for a closed time window. */
export async function settleForApi(
  slug: string,
  period: SettlementPeriod,
): Promise<{ inserted: boolean; owedMicro: bigint; requests: number }> {
  const [agg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${requests.costMicro})::text, '0')`,
    })
    .from(requests)
    .where(
      and(
        eq(requests.apiSlug, slug),
        eq(requests.cacheHit, false), // cache hits don't cost upstream
        gte(requests.createdAt, period.start),
        lt(requests.createdAt, period.end),
      ),
    );

  const owedMicro = BigInt(agg?.total ?? '0');
  const reqCount = agg?.count ?? 0;

  if (reqCount === 0) return { inserted: false, owedMicro: 0n, requests: 0 };

  // Atomic upsert via the unique index on (api_slug, period_start, period_end)
  // so concurrent settle runs (cron + manual retry overlapping) never
  // duplicate a row. ON CONFLICT path keeps the latest aggregate so
  // re-running for corrections still wins. If status is already 'paid'
  // we leave it alone to avoid resurrecting closed settlements.
  const inserted = await db
    .insert(settlements)
    .values({
      apiSlug: slug,
      periodStart: period.start,
      periodEnd: period.end,
      requestCount: reqCount,
      owedMicro,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [settlements.apiSlug, settlements.periodStart, settlements.periodEnd],
      set: { requestCount: reqCount, owedMicro },
      setWhere: sql`${settlements.status} <> 'paid'`,
    })
    .returning({ id: settlements.id });

  return { inserted: inserted.length > 0, owedMicro, requests: reqCount };
}

/** Settle every active slug that had traffic in the window.
 *
 * Per-slug failures are isolated — one bad upstream slug doesn't take
 * down the whole batch. Each result includes either the aggregate or
 * an error message, so the operator can see exactly what landed and
 * what didn't (the previous loop bubbled the first throw and lost the
 * progress made on prior slugs). settleForApi is idempotent (ON
 * CONFLICT DO UPDATE skipped for paid rows), so a manual retry after
 * a partial run only re-touches the slugs that errored.
 */
export async function settleAll(period: SettlementPeriod) {
  const { log } = await import('~/lib/logger');
  const t0 = Date.now();
  const slugs = await db
    .select({ slug: requests.apiSlug })
    .from(requests)
    .where(
      and(
        gte(requests.createdAt, period.start),
        lt(requests.createdAt, period.end),
        eq(requests.cacheHit, false),
      ),
    )
    .groupBy(requests.apiSlug);

  log.info('settlement.run.start', {
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    slug_count: slugs.length,
  });

  const results: Array<{
    slug: string;
    inserted?: boolean;
    owedMicro: bigint;
    requests?: number;
    error?: string;
  }> = [];
  let successes = 0;
  let failures = 0;
  for (const { slug } of slugs) {
    try {
      const r = await settleForApi(slug, period);
      results.push({ slug, ...r });
      successes++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('settlement.slug.failed', { slug, error: msg });
      results.push({ slug, owedMicro: 0n, error: msg });
      failures++;
    }
  }

  log.info('settlement.run.done', {
    duration_ms: Date.now() - t0,
    slug_count: slugs.length,
    successes,
    failures,
  });
  return results;
}

/** Mark a settlement row paid (human confirmation / finance workflow).
 * Idempotent: re-running with the same id is a no-op once status='paid'. */
export async function markPaid(id: string, paidRef: string): Promise<void> {
  await db
    .update(settlements)
    .set({ status: 'paid', paidAt: new Date(), paidRef })
    .where(and(eq(settlements.id, id), sql`${settlements.status} <> 'paid'`));
}

/** Convenience for "last full UTC day". */
export function yesterdayUTC(): SettlementPeriod {
  const now = new Date();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}
