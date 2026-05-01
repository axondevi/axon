/**
 * USDC-native subscription engine.
 *
 * Tiers are stored on `users.tier` with `users.tier_expires_at` marking
 * when the active period ends. The auth middleware treats an expired tier
 * as 'free' for rate-limit + markup-discount purposes, so callers don't
 * need to do their own expiry math. The daily renewal cron rewrites the
 * row when a sub renews / lapses.
 */
import { eq, and, lte, isNotNull } from 'drizzle-orm';
import { db } from '~/db';
import { users } from '~/db/schema';
import { debit } from '~/wallet/service';
import { Errors } from '~/lib/errors';

export type Tier = 'free' | 'pro' | 'team' | 'enterprise';

// Monthly price in micro-USDC (1 USDC = 1_000_000 micro)
export const TIER_PRICES: Record<Tier, bigint> = {
  free: 0n,
  pro: 20_000_000n,    // $20/month
  team: 100_000_000n,  // $100/month
  enterprise: 0n,      // custom — not self-service
};

// Markup discount on per-call price for paying tiers (% off the registry markup_pct).
// E.g. an endpoint with markup_pct=15 charged to a Pro user (-25% discount) effectively
// charges 15 * (1 - 0.25) = 11.25% markup.
export const TIER_MARKUP_DISCOUNT_PCT: Record<Tier, number> = {
  free: 0,
  pro: 25,
  team: 50,
  enterprise: 75,
};

// Per-tier rate-limit ceiling, mirrored in src/middleware/rate-limit.ts
export const TIER_RATE_LIMITS: Record<Tier, number> = {
  free: 10,
  pro: 600,
  team: 3000,
  enterprise: 30000,
};

export const PERIOD_DAYS = 30;
const PERIOD_MS = PERIOD_DAYS * 24 * 60 * 60 * 1000;

export function isPaidTier(tier: string): tier is Exclude<Tier, 'free'> {
  return tier === 'pro' || tier === 'team' || tier === 'enterprise';
}

/** Returns the tier currently in effect, accounting for expiry. */
export function effectiveTier(u: { tier: string; tierExpiresAt: Date | null }): Tier {
  if (!u.tier || u.tier === 'free') return 'free';
  if (!u.tierExpiresAt) return 'free';
  if (u.tierExpiresAt.getTime() <= Date.now()) return 'free';
  return u.tier as Tier;
}

/**
 * Subscribe (or renew) the user to `tier` for one period. Debits the price
 * from the wallet and bumps tier_expires_at by PERIOD_DAYS forward — so a
 * user renewing 5 days early gets the remaining time added on top.
 *
 * Throws insufficientFunds if balance < tier price.
 */
export async function subscribe(userId: string, tier: Tier, opts: { autoRenew?: boolean } = {}) {
  if (!isPaidTier(tier)) throw Errors.badRequest('Cannot subscribe to free tier');
  if (tier === 'enterprise') throw Errors.badRequest('Enterprise tier is not self-service — contact us');

  const price = TIER_PRICES[tier];
  if (price <= 0n) throw Errors.badRequest('Invalid tier price');

  // Concurrency guard. Without this, two parallel subscribe() calls (e.g.
  // a frantic double-click on "Upgrade") both pass the balance check, both
  // debit the price, but the expiry update is last-write-wins — the user
  // pays 2× and only gets 1 period of tier. Redis SET NX with a 30-second
  // TTL serializes the operation per (user, tier).
  const { redis } = await import('~/cache/redis');
  const lockKey = `subscribe:lock:${userId}:${tier}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
  if (!acquired) {
    throw Errors.badRequest('A subscription request is already in progress. Wait a moment and try again.');
  }
  try {
    const [existing] = await db.select().from(users).where(eq(users.id, userId));
    if (!existing) throw Errors.notFound('User');

    // Compute new expiry. If still active in same tier, extend; otherwise start fresh.
    const now = new Date();
    let baseTime = now.getTime();
    if (existing.tier === tier && existing.tierExpiresAt && existing.tierExpiresAt.getTime() > now.getTime()) {
      baseTime = existing.tierExpiresAt.getTime();
    }
    const newExpiry = new Date(baseTime + PERIOD_MS);

    // Atomic debit happens first — if it throws (insufficient funds), we never
    // touch the tier. We tag the transaction so the dashboard renders nicely.
    await debit({
      userId,
      amountMicro: price,
      type: 'subscription_charge',
      apiSlug: '__subscription__',
      meta: {
        kind: 'subscription_charge',
        tier,
        period_days: PERIOD_DAYS,
        previous_tier: existing.tier,
        previous_expires_at: existing.tierExpiresAt?.toISOString() ?? null,
        new_expires_at: newExpiry.toISOString(),
      },
    });

    await db
      .update(users)
      .set({
        tier,
        tierExpiresAt: newExpiry,
        tierAutoRenew: opts.autoRenew ?? true,
      })
      .where(eq(users.id, userId));

    return {
      tier,
      expires_at: newExpiry.toISOString(),
      auto_renew: opts.autoRenew ?? true,
      charged_micro: price,
    };
  } finally {
    // Best-effort lock release; TTL covers crashes.
    redis.del(lockKey).catch(() => {});
  }
}

/**
 * Cancel auto-renew. The user keeps the current paid tier until tierExpiresAt,
 * then automatically falls back to free.
 */
export async function cancelAutoRenew(userId: string) {
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (!existing) throw Errors.notFound('User');
  await db
    .update(users)
    .set({ tierAutoRenew: false })
    .where(eq(users.id, userId));
  return {
    tier: existing.tier,
    expires_at: existing.tierExpiresAt?.toISOString() ?? null,
    auto_renew: false,
  };
}

/** Read current subscription state for the dashboard. */
export async function getSubscription(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw Errors.notFound('User');
  const eff = effectiveTier(u);
  return {
    tier_active: u.tier,
    tier_effective: eff,
    expires_at: u.tierExpiresAt?.toISOString() ?? null,
    auto_renew: u.tierAutoRenew,
    days_remaining: u.tierExpiresAt
      ? Math.max(0, Math.ceil((u.tierExpiresAt.getTime() - Date.now()) / 86_400_000))
      : null,
    rate_limit_per_min: TIER_RATE_LIMITS[eff],
    markup_discount_pct: TIER_MARKUP_DISCOUNT_PCT[eff],
  };
}

/**
 * Daily cron: find subs whose tier_expires_at is in the past. If auto_renew
 * + sufficient balance → renew. Otherwise → drop to 'free'.
 *
 * Returns counts for observability.
 */
export async function processExpiringSubscriptions() {
  const now = new Date();
  const expired = await db
    .select()
    .from(users)
    .where(and(isNotNull(users.tierExpiresAt), lte(users.tierExpiresAt, now)));

  let renewed = 0;
  let downgraded = 0;
  let failed = 0;

  for (const u of expired) {
    if (u.tier === 'free') continue;
    if (u.tierAutoRenew && isPaidTier(u.tier)) {
      try {
        await subscribe(u.id, u.tier as Tier, { autoRenew: true });
        renewed++;
        continue;
      } catch (err) {
        failed++;
        // Fall through to downgrade
      }
    }
    await db
      .update(users)
      .set({ tier: 'free', tierExpiresAt: null, tierAutoRenew: true })
      .where(eq(users.id, u.id));
    downgraded++;
  }

  return { processed: expired.length, renewed, downgraded, failed };
}
