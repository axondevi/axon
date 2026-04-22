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

const TIER_LIMITS: Record<string, number> = {
  free: 10,
  pro: 600,
  team: 3000,
  enterprise: 30000,
};

const WINDOW_SEC = 60;

export async function rateLimit(c: Context, next: Next) {
  const user = c.get('user') as { id: string; tier?: string } | undefined;
  if (!user) {
    // No user set → auth middleware should have thrown already
    await next();
    return;
  }

  const tier = user.tier ?? 'free';
  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.free;

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_SEC);
  const key = `ratelimit:${user.id}:${window}`;

  const pipeline = redis.multi();
  pipeline.incr(key);
  pipeline.expire(key, WINDOW_SEC + 5);
  const execRes = await pipeline.exec();

  // ioredis exec() returns [[err, result], ...]; be defensive.
  const count = Number(execRes?.[0]?.[1] ?? 0);

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
