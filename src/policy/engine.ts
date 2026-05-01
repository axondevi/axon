/**
 * Policy enforcement.
 *
 * Called before debit. Returns silently if allowed, throws 403 AppError
 * with structured meta if denied.
 *
 * Uses Postgres (not Redis) for budget counting to share the source of
 * truth with the transaction ledger.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '~/db';
import { policies, requests } from '~/db/schema';
import { AppError } from '~/lib/errors';
import { redis } from '~/cache/redis';
import { log } from '~/lib/logger';
import type { Policy } from './types';

// 24h+slack TTL — long enough to not expire mid-day in any timezone,
// short enough that stale counters self-clear if a deploy goes sideways.
const BUDGET_TTL_SEC = 26 * 60 * 60;
const MONTHLY_TTL_SEC = 32 * 24 * 60 * 60;

/**
 * Budget reservation backed by Redis counters. The Postgres-based
 * sumSpendSince() reads were a TOCTOU window: two parallel calls saw the
 * same `spent`, both passed, both committed — small daily-budget overrun.
 * Redis INCRBY is atomic on the server, so each call observes the
 * post-increment total; we roll back on cap-overshoot or upstream
 * failure.
 *
 * Drift: the Redis counter starts at 0 each day and is independent of
 * the Postgres ledger; refunds do `decrby`. If Redis flushes mid-day
 * the counter resets to 0 and the user effectively gets a fresh budget
 * window — accepted as a fail-open trade-off (operator visibility via
 * the daily_budget_redis_unavailable warning beats blocking traffic).
 */
function dayKey(userId: string, scope: string): string {
  // YYYY-MM-DD in UTC — aligns with the 24h sliding window approximated
  // by the Postgres path. Drift up to ~24h is acceptable; rolling-window
  // precision wasn't there before either.
  return `budget:${scope}:${userId}:${new Date().toISOString().slice(0, 10)}`;
}

function monthKey(userId: string, scope: string): string {
  return `budget:${scope}:${userId}:${new Date().toISOString().slice(0, 7)}`;
}

async function reserveBudget(
  bucketKey: string,
  amount: bigint,
  cap: bigint,
  ttlSec: number,
): Promise<{ ok: true; total: bigint } | { ok: false; total: bigint }> {
  // INCRBY returns the post-increment value atomically. EXPIRE is best-
  // effort — if it fails we still set on the next call. Keeping these
  // separate (not in MULTI) means a Redis hiccup on EXPIRE doesn't block
  // the path; the key TTLs from a prior day's call.
  const amt = Number(amount);
  if (!Number.isSafeInteger(amt)) {
    log.warn('policy_amount_exceeds_safe_int', { bucketKey, amount: amount.toString() });
    return { ok: false, total: cap + 1n };
  }
  let total: bigint;
  try {
    const newVal = await redis.incrby(bucketKey, amt);
    total = BigInt(newVal);
  } catch (err) {
    log.warn('policy_redis_unavailable', {
      bucketKey,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fail-open on Redis outage so traffic keeps flowing. The Postgres
    // sumSpendSince path stays as the audit trail.
    return { ok: true, total: 0n };
  }
  redis.expire(bucketKey, ttlSec).catch(() => {});
  if (total > cap) {
    // Roll back the over-shoot so the next caller sees the pre-increment
    // value and can still pass if they fit. Best-effort — even if this
    // fails, the counter naturally clears on TTL.
    redis.decrby(bucketKey, amt).catch(() => {});
    return { ok: false, total };
  }
  return { ok: true, total };
}

/**
 * Release reserved budget — call on upstream failure or cost
 * reconciliation refund. Best-effort; the daily TTL bounds drift.
 */
export async function releaseBudget(
  userId: string,
  slug: string,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) return;
  const amt = Number(amount);
  if (!Number.isSafeInteger(amt)) return;
  const keys = [
    dayKey(userId, 'daily'),
    dayKey(userId, `api:${slug}`),
    monthKey(userId, 'monthly'),
  ];
  for (const k of keys) {
    try {
      await redis.decrby(k, amt);
    } catch {
      // best-effort
    }
  }
}

export async function loadPolicy(userId: string): Promise<Policy | null> {
  const [row] = await db
    .select()
    .from(policies)
    .where(eq(policies.userId, userId))
    .limit(1);
  return (row?.rules as Policy) ?? null;
}

export async function upsertPolicy(userId: string, rules: Policy): Promise<void> {
  await db
    .insert(policies)
    .values({ userId, rules })
    .onConflictDoUpdate({
      target: policies.userId,
      set: { rules, updatedAt: new Date() },
    });
}

export async function deletePolicy(userId: string): Promise<void> {
  await db.delete(policies).where(eq(policies.userId, userId));
}

/**
 * Evaluate a pending call against the user's policy.
 *
 * Throws 403 `policy_denied` with meta describing the violating rule.
 */
export async function enforcePolicy(params: {
  userId: string;
  slug: string;
  estimatedCostMicro: bigint;
  cacheHit: boolean;
}) {
  const { userId, slug, estimatedCostMicro, cacheHit } = params;
  const policy = await loadPolicy(userId);
  if (!policy) return; // no policy = allow

  // 1. Allow/deny lists
  if (policy.deny_apis?.includes(slug)) {
    throw denied('api_denied', `API '${slug}' is denied by policy`, { slug });
  }
  if (policy.allow_apis && policy.allow_apis.length > 0 && !policy.allow_apis.includes(slug)) {
    throw denied('api_not_allowed', `API '${slug}' is not in the allowlist`, {
      slug,
      allowed: policy.allow_apis,
    });
  }

  // 2. Per-request ceiling
  if (policy.max_request_cost_micro) {
    const cap = BigInt(policy.max_request_cost_micro);
    if (estimatedCostMicro > cap) {
      throw denied(
        'max_request_cost_exceeded',
        'Call would exceed per-request cost cap',
        { cap_micro: cap.toString(), cost_micro: estimatedCostMicro.toString() },
      );
    }
  }

  // 3. Budget windows (cache can be excluded). Redis-backed atomic
  // reservation closes the TOCTOU window the SQL-sum-then-debit path
  // had: two parallel calls used to both see the same `spent`, both
  // pass, both commit, and overrun the cap. INCRBY is atomic, so the
  // second caller observes the post-increment value.
  const countThisCall =
    !cacheHit || !policy.exclude_cache_from_budget ? estimatedCostMicro : 0n;

  if (countThisCall > 0n) {
    if (policy.daily_budget_micro) {
      const cap = BigInt(policy.daily_budget_micro);
      const res = await reserveBudget(dayKey(userId, 'daily'), countThisCall, cap, BUDGET_TTL_SEC);
      if (!res.ok) {
        throw denied('daily_budget_exceeded', 'Call would exceed the daily budget', {
          cap_micro: cap.toString(),
          spent_micro: (res.total - countThisCall).toString(),
          attempted_micro: countThisCall.toString(),
        });
      }
    }

    if (policy.monthly_budget_micro) {
      const cap = BigInt(policy.monthly_budget_micro);
      const res = await reserveBudget(monthKey(userId, 'monthly'), countThisCall, cap, MONTHLY_TTL_SEC);
      if (!res.ok) {
        // Roll back the daily reserve so we don't leak headroom.
        if (policy.daily_budget_micro) {
          redis.decrby(dayKey(userId, 'daily'), Number(countThisCall)).catch(() => {});
        }
        throw denied('monthly_budget_exceeded', 'Call would exceed the monthly budget', {
          cap_micro: cap.toString(),
          spent_micro: (res.total - countThisCall).toString(),
          attempted_micro: countThisCall.toString(),
        });
      }
    }

    // 4. Per-API daily cap
    if (policy.per_api_daily_micro?.[slug]) {
      const cap = BigInt(policy.per_api_daily_micro[slug]);
      const res = await reserveBudget(dayKey(userId, `api:${slug}`), countThisCall, cap, BUDGET_TTL_SEC);
      if (!res.ok) {
        // Roll back the broader buckets we already reserved.
        if (policy.monthly_budget_micro) {
          redis.decrby(monthKey(userId, 'monthly'), Number(countThisCall)).catch(() => {});
        }
        if (policy.daily_budget_micro) {
          redis.decrby(dayKey(userId, 'daily'), Number(countThisCall)).catch(() => {});
        }
        throw denied('per_api_daily_exceeded', `Call would exceed daily cap for '${slug}'`, {
          slug,
          cap_micro: cap.toString(),
          spent_micro: (res.total - countThisCall).toString(),
        });
      }
    }
  }
}

async function sumSpendSince(
  userId: string,
  since: Date,
  apiSlug?: string,
  excludeCache?: boolean,
): Promise<bigint> {
  const conds = [eq(requests.userId, userId), gte(requests.createdAt, since)];
  if (apiSlug) conds.push(eq(requests.apiSlug, apiSlug));
  if (excludeCache) conds.push(eq(requests.cacheHit, false));

  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${requests.costMicro})::text, '0')`,
    })
    .from(requests)
    .where(and(...conds));

  return BigInt(row?.total ?? '0');
}

function denied(
  code: string,
  message: string,
  meta: Record<string, unknown>,
): AppError {
  return new AppError(403, 'policy_denied', message, { rule: code, ...meta });
}
