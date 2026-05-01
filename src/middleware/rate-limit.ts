/**
 * Redis-backed fixed-window rate limiter, per user tier.
 *
 * Uses INCR + EXPIRE atomically. Keys bucket by minute:
 *   ratelimit:{user_id}:{unix_minute}
 *
 * Returns 429 with `retry-after: <seconds-until-next-window>`.
 */
import type { Context, Next } from 'hono';
import { redis } from '~/cache/redis';
import { TIER_RATE_LIMITS, effectiveTier } from '~/subscription';
import { env } from '~/config';
import { log } from '~/lib/logger';

const WINDOW_SEC = 60;

export async function rateLimit(c: Context, next: Next) {
  const user = c.get('user') as { id: string; tier?: string; tierExpiresAt?: Date | null } | undefined;
  if (!user) {
    // No user set → auth middleware should have thrown already
    await next();
    return;
  }

  // effectiveTier respects tier_expires_at, so a lapsed Pro user is throttled at free's 10/min
  const tier = effectiveTier({ tier: user.tier ?? 'free', tierExpiresAt: user.tierExpiresAt ?? null });
  const limit = TIER_RATE_LIMITS[tier] ?? TIER_RATE_LIMITS.free;

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_SEC);
  const key = `ratelimit:${user.id}:${window}`;

  let count = 0;
  let redisOk = true;
  try {
    const pipeline = redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, WINDOW_SEC + 5);
    const execRes = await pipeline.exec();
    // ioredis exec() returns [[err, result], ...] — surface the per-op
    // error rather than coercing it to 0 (which silently bypassed the
    // limiter when Redis hiccuped).
    const [opErr, opVal] = execRes?.[0] ?? [null, 0];
    if (opErr) throw opErr;
    count = Number(opVal ?? 0);
  } catch (err) {
    redisOk = false;
    log.error('ratelimit_redis_unavailable', {
      user_id: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fail-closed in production: an unreachable Redis previously meant
  // unlimited traffic. Refuse the request instead so a Redis outage
  // can't be exploited to drain margin.
  if (!redisOk && env.NODE_ENV === 'production') {
    return c.json(
      {
        error: 'rate_limiter_unavailable',
        message: 'Rate limiter dependency unavailable. Try again shortly.',
      },
      503,
      { 'retry-after': '5' },
    );
  }

  const remaining = Math.max(0, limit - count);
  const reset = (window + 1) * WINDOW_SEC - now;

  c.header('x-ratelimit-limit', String(limit));
  c.header('x-ratelimit-remaining', String(remaining));
  c.header('x-ratelimit-reset', String(reset));

  if (count > limit) {
    // Return directly so headers survive (throwing goes through onError
    // which creates a fresh response and may drop per-request headers).
    return c.json(
      {
        error: 'rate_limited',
        message: `Rate limit exceeded: ${limit} requests/minute on tier '${tier}'`,
        meta: { limit, window_sec: WINDOW_SEC, retry_after_sec: reset },
      },
      429,
      {
        'retry-after': String(reset),
        'x-ratelimit-limit': String(limit),
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      },
    );
  }

  await next();
}
