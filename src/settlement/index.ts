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

  // Upsert: same (slug, period) overwrites (in case we re-run for corrections)
  const existing = await db
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.apiSlug, slug),
        eq(settlements.periodStart, period.start),
        eq(settlements.periodEnd, period.end),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(settlements)
      .set({
        requestCount: reqCount,
        owedMicro,
      })
      .where(eq(settlements.id, existing[0].id));
    return { inserted: false, owedMicro, requests: reqCount };
  }

  await db.insert(settlements).values({
    apiSlug: slug,
    periodStart: period.start,
    periodEnd: period.end,
    requestCount: reqCount,
    owedMicro,
    status: 'pending',
  });

  return { inserted: true, owedMicro, requests: reqCount };
}

/** Settle every active slug that had traffic in the window. */
export async function settleAll(period: SettlementPeriod) {
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

  const results = [];
  for (const { slug } of slugs) {
    results.push({ slug, ...(await settleForApi(slug, period)) });
  }
  return results;
}

/** Mark a settlement row paid (human confirmation / finance workflow). */
export async function markPaid(id: string, paidRef: string): Promise<void> {
  await db
    .update(settlements)
    .set({ status: 'paid', paidAt: new Date(), paidRef })
    .where(eq(settlements.id, id));
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
