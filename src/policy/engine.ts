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
import type { Policy } from './types';

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

  // 3. Budget windows (cache can be excluded)
  const countThisCall =
    !cacheHit || !policy.exclude_cache_from_budget ? estimatedCostMicro : 0n;

  const excludeCache = !!policy.exclude_cache_from_budget;

  if (policy.daily_budget_micro) {
    const cap = BigInt(policy.daily_budget_micro);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const spent = await sumSpendSince(userId, since, undefined, excludeCache);
    if (spent + countThisCall > cap) {
      throw denied(
        'daily_budget_exceeded',
        'Call would exceed the daily budget',
        {
          cap_micro: cap.toString(),
          spent_micro: spent.toString(),
          attempted_micro: countThisCall.toString(),
        },
      );
    }
  }

  if (policy.monthly_budget_micro) {
    const cap = BigInt(policy.monthly_budget_micro);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const spent = await sumSpendSince(userId, since, undefined, excludeCache);
    if (spent + countThisCall > cap) {
      throw denied(
        'monthly_budget_exceeded',
        'Call would exceed the monthly budget',
        {
          cap_micro: cap.toString(),
          spent_micro: spent.toString(),
          attempted_micro: countThisCall.toString(),
        },
      );
    }
  }

  // 4. Per-API daily cap
  if (policy.per_api_daily_micro?.[slug]) {
    const cap = BigInt(policy.per_api_daily_micro[slug]);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const spent = await sumSpendSince(userId, since, slug, excludeCache);
    if (spent + countThisCall > cap) {
      throw denied(
        'per_api_daily_exceeded',
        `Call would exceed daily cap for '${slug}'`,
        {
          slug,
          cap_micro: cap.toString(),
          spent_micro: spent.toString(),
        },
      );
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
