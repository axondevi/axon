/**
 * Public-route rate limiter — keyed by client IP.
 *
 * The authed rate limiter (rate-limit.ts) keys by user_id, which doesn't
 * help when there's no authenticated user yet. Public catalog endpoints
 * (/v1/apis, /v1/personas, /v1/stats/public, /agent-meta/...) without
 * any limit let a scraper hammer the DB and inflate Render bandwidth.
 *
 * Single fixed-window bucket per IP, generous default (60/min) so it
 * doesn't get in the way of legitimate users behind shared NAT (mobile
 * carriers).
 */
import type { Context, Next } from 'hono';
import { redis } from '~/cache/redis';
import { log } from '~/lib/logger';
import { env } from '~/config';

const WINDOW_SEC = 60;
const DEFAULT_LIMIT = 60;

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '0.0.0.0';
}

export function publicRateLimit(opts: { perMin?: number; bucket?: string } = {}) {
  const limit = opts.perMin ?? DEFAULT_LIMIT;
  const bucket = opts.bucket ?? 'public';
  return async function publicRateLimitMw(c: Context, next: Next) {
    const ip = clientIp(c);
    const window = Math.floor(Date.now() / 1000 / WINDOW_SEC);
    const key = `prl:${bucket}:${ip}:${window}`;

    let count = 0;
    let redisOk = true;
    try {
      const pipe = redis.multi();
      pipe.incr(key);
      pipe.expire(key, WINDOW_SEC + 5);
      const r = await pipe.exec();
      const [opErr, opVal] = r?.[0] ?? [null, 0];
      if (opErr) throw opErr;
      count = Number(opVal ?? 0);
    } catch (err) {
      redisOk = false;
      log.warn('public_ratelimit_redis_error', {
        ip,
        bucket,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fail-open in dev, fail-closed in prod for the same reason as the
    // authed rate limiter — outage shouldn't be exploitable for unlimited
    // scraping.
    if (!redisOk && env.NODE_ENV === 'production') {
      return c.json(
        { error: 'rate_limiter_unavailable' },
        503,
        { 'retry-after': '5' },
      );
    }

    if (count > limit) {
      return c.json(
        { error: 'rate_limited', message: `Too many requests; try again shortly.` },
        429,
        { 'retry-after': String(WINDOW_SEC) },
      );
    }

    await next();
  };
}
